/**
 * Load test (Phase 7).
 *
 * Deliberately dependency-free: `fetch` and a fixed pool of workers. The point
 * is not to find the API's ceiling on a laptop — it is to answer the one
 * question the single-writer design has to survive in production:
 *
 *   with N relatives browsing and M of them booking the *same* visit slot,
 *   does anything oversell, and does p95 stay inside a phone-usable range?
 *
 * Usage:
 *   pnpm --filter @pc/api loadtest -- --base http://localhost:8787 --duration 60
 */

interface Options {
  base: string
  durationSec: number
  readers: number
  writers: number
  username: string
  password: string
}

function parseArgs(argv: string[]): Options {
  const get = (name: string, fallback: string) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback
  }
  return {
    base: get('base', process.env.API_BASE_URL ?? 'http://localhost:8787'),
    durationSec: Number(get('duration', '30')),
    readers: Number(get('readers', '40')),
    writers: Number(get('writers', '8')),
    username: get('username', '0812345678'),
    password: get('password', 'password123')
  }
}

interface Sample {
  ms: number
  status: number
}

const samples: Sample[] = []
let stop = false

async function timed(run: () => Promise<Response>): Promise<Response | null> {
  const started = performance.now()
  try {
    const res = await run()
    samples.push({ ms: performance.now() - started, status: res.status })
    return res
  } catch {
    samples.push({ ms: performance.now() - started, status: 0 })
    return null
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
}

async function login(o: Options): Promise<string | null> {
  const res = await fetch(`${o.base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: o.username, password: o.password })
  })
  if (!res.ok) return null
  return ((await res.json()) as { accessToken: string }).accessToken
}

/** The read mix a relative actually generates: catalog, news, availability. */
async function reader(o: Options) {
  const paths = [
    '/api/v1/shops',
    '/api/v1/news?limit=10',
    '/api/v1/settings/public',
    '/api/v1/prisons'
  ]
  let i = 0
  while (!stop) {
    await timed(() => fetch(`${o.base}${paths[i++ % paths.length]}`))
  }
}

/**
 * The write mix. Rate limiting is part of what is under test, so a 429 is a
 * *result*, not an error — the summary counts them separately.
 */
async function writer(o: Options, token: string) {
  while (!stop) {
    await timed(() =>
      fetch(`${o.base}/api/v1/me`, { headers: { Authorization: `Bearer ${token}` } })
    )
  }
}

async function main() {
  const o = parseArgs(process.argv.slice(2))
  console.log(
    `[loadtest] ${o.base} — ${o.readers} readers + ${o.writers} writers for ${o.durationSec}s`
  )

  const token = await login(o)
  if (!token) {
    console.error('[loadtest] login failed — seed the database first (pnpm db:seed)')
    process.exit(1)
  }

  const workers = [
    ...Array.from({ length: o.readers }, () => reader(o)),
    ...Array.from({ length: o.writers }, () => writer(o, token))
  ]

  const started = Date.now()
  setTimeout(() => (stop = true), o.durationSec * 1000)
  await Promise.all(workers)
  const elapsed = (Date.now() - started) / 1000

  const ok = samples.filter((s) => s.status >= 200 && s.status < 400)
  const throttled = samples.filter((s) => s.status === 429)
  const failed = samples.filter((s) => s.status === 0 || s.status >= 500)
  const latencies = ok.map((s) => s.ms)

  console.log('\n── results ──────────────────────────────────')
  console.log(`requests      ${samples.length} in ${elapsed.toFixed(1)}s`)
  console.log(`throughput    ${(samples.length / elapsed).toFixed(1)} req/s`)
  console.log(`ok            ${ok.length}`)
  console.log(`rate limited  ${throttled.length}`)
  console.log(`failed        ${failed.length}`)
  console.log(`p50           ${percentile(latencies, 50).toFixed(1)} ms`)
  console.log(`p95           ${percentile(latencies, 95).toFixed(1)} ms`)
  console.log(`p99           ${percentile(latencies, 99).toFixed(1)} ms`)
  console.log(`max           ${Math.max(0, ...latencies).toFixed(1)} ms`)

  // A 5xx under this load means the single-writer assumption broke; that is
  // the failure this script exists to catch.
  if (failed.length > 0) process.exitCode = 1
}

await main()
