import { ApiError, type ErrorCode } from './common.js'
import type {
  AdminMeResponse,
  ChangePasswordInput,
  LoginInput,
  MeResponse,
  RegisterInput,
  SessionResponse,
  UpdateMeInput
} from './auth.js'
import type { PrisonDetail, PrisonSummary } from './facility.js'
import type {
  Category,
  CreateCategoryInput,
  CreateProductInput,
  CreateShopInput,
  Product,
  ShopDetail,
  ShopHoursInput,
  ShopSummary,
  UpdateCategoryInput,
  UpdateProductInput,
  UpdateShopInput
} from './catalog.js'
import type {
  CreateOrderInput,
  FulfillmentStatus,
  OrderDetail,
  OrderSummary,
  PaymentStatus,
  UpdateFulfillmentInput
} from './orders.js'
import type { PublicSettings } from './settings.js'

interface Page<T> {
  items: T[]
  nextCursor: string | null
}

export class ApiClientError extends Error {
  readonly status: number
  readonly code: ErrorCode | string
  readonly fields?: Record<string, string[]>
  constructor(status: number, code: string, message: string, fields?: Record<string, string[]>) {
    super(message)
    this.name = 'ApiClientError'
    this.status = status
    this.code = code
    this.fields = fields
  }
}

export type Realm = 'customer' | 'admin'

export interface ClientOptions {
  baseUrl: string
  realm?: Realm
  /** Called when refresh fails — the app should route to login. */
  onAuthExpired?: () => void
  fetch?: typeof globalThis.fetch
}

interface RequestOptions {
  method?: string
  body?: unknown
  query?: Record<string, string | number | boolean | undefined | null>
  /** multipart passthrough — skips JSON encoding */
  form?: FormData
  signal?: AbortSignal
  /** Internal: prevents refresh recursion. */
  retryOn401?: boolean
}

/**
 * The access token lives in this closure and nowhere else. Never localStorage:
 * the LINE in-app webview shares storage across the whole origin.
 */
export function createApiClient(opts: ClientOptions) {
  const base = opts.baseUrl.replace(/\/+$/, '')
  const realm: Realm = opts.realm ?? 'customer'
  const prefix = realm === 'admin' ? '/admin' : ''
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis)

  let accessToken: string | null = null
  let refreshing: Promise<boolean> | null = null

  function url(path: string, query?: RequestOptions['query']) {
    const u = new URL(base + path, base.startsWith('http') ? undefined : 'http://local')
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v))
      }
    }
    return base.startsWith('http') ? u.toString() : u.pathname + u.search
  }

  async function raw<T>(path: string, o: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`
    let body: BodyInit | undefined
    if (o.form) {
      body = o.form
    } else if (o.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(o.body)
    }

    const res = await doFetch(url(path, o.query), {
      method: o.method ?? 'GET',
      headers,
      body,
      credentials: 'include',
      signal: o.signal
    })

    if (res.status === 401 && o.retryOn401 !== false) {
      const ok = await refreshOnce()
      if (ok) return raw<T>(path, { ...o, retryOn401: false })
      accessToken = null
      opts.onAuthExpired?.()
    }

    if (!res.ok) throw await toError(res)
    if (res.status === 204) return undefined as T
    const ct = res.headers.get('content-type') ?? ''
    if (!ct.includes('application/json')) return (await res.blob()) as T
    return (await res.json()) as T
  }

  async function toError(res: Response) {
    let code = 'INTERNAL'
    let message = res.statusText || 'Request failed'
    let fields: Record<string, string[]> | undefined
    try {
      const parsed = ApiError.safeParse(await res.json())
      if (parsed.success) {
        code = parsed.data.error.code
        message = parsed.data.error.message
        fields = parsed.data.error.fields
      }
    } catch {
      /* non-JSON error body — keep the status text */
    }
    return new ApiClientError(res.status, code, message, fields)
  }

  /** Concurrent 401s share one refresh flight. */
  function refreshOnce(): Promise<boolean> {
    refreshing ??= (async () => {
      try {
        const res = await doFetch(url(`${prefix}/auth/refresh`), {
          method: 'POST',
          credentials: 'include',
          headers: { Accept: 'application/json' }
        })
        if (!res.ok) return false
        const session = (await res.json()) as SessionResponse
        accessToken = session.accessToken
        return true
      } catch {
        return false
      } finally {
        // Cleared on the next microtask so callers awaiting this flight all see it.
        queueMicrotask(() => (refreshing = null))
      }
    })()
    return refreshing
  }

  function adopt(session: SessionResponse) {
    accessToken = session.accessToken
    return session
  }

  return {
    get token() {
      return accessToken
    },
    setToken(t: string | null) {
      accessToken = t
    },
    request: raw,

    /** Restores a session from the refresh cookie on app boot. */
    async resume(): Promise<boolean> {
      return refreshOnce()
    },

    auth: {
      register: (input: RegisterInput) =>
        raw<SessionResponse>('/auth/register', { method: 'POST', body: input }).then(adopt),
      login: (input: LoginInput) =>
        raw<SessionResponse>(`${prefix}/auth/login`, {
          method: 'POST',
          body: input,
          retryOn401: false
        }).then(adopt),
      refresh: () => refreshOnce(),
      changePassword: (input: ChangePasswordInput) =>
        raw<SessionResponse>(`${prefix}/auth/change-password`, {
          method: 'POST',
          body: input
        }).then(adopt),
      async logout() {
        try {
          await raw(`${prefix}/auth/logout`, { method: 'POST', retryOn401: false })
        } finally {
          accessToken = null
        }
      }
    },

    me: {
      get: () => raw<MeResponse>('/me'),
      update: (input: UpdateMeInput) => raw<MeResponse>('/me', { method: 'PATCH', body: input })
    },

    catalog: {
      shops: (query: { prisonId?: string; zoneId?: string } = {}) =>
        raw<{ items: ShopSummary[] }>('/shops', { query }),
      shop: (id: string) => raw<ShopDetail>(`/shops/${id}`),
      categories: (query: { shopId?: string } = {}) =>
        raw<{ items: Category[] }>('/categories', { query }),
      products: (query: {
        shopId: string
        categoryId?: string
        q?: string
        cursor?: string
        limit?: number
      }) => raw<Page<Product>>('/products', { query }),
      product: (id: string) => raw<Product>(`/products/${id}`)
    },

    orders: {
      create: (input: CreateOrderInput) =>
        raw<OrderDetail>('/orders', { method: 'POST', body: input }),
      list: (query: { cursor?: string; limit?: number; status?: FulfillmentStatus } = {}) =>
        raw<Page<OrderSummary>>('/orders', { query }),
      get: (id: string) => raw<OrderDetail>(`/orders/${id}`)
    },

    admin: {
      me: () => raw<AdminMeResponse>('/admin/me'),

      shops: {
        list: (query: { prisonId?: string; includeInactive?: boolean } = {}) =>
          raw<{ items: ShopSummary[] }>('/admin/shops', { query }),
        get: (id: string) => raw<ShopDetail>(`/admin/shops/${id}`),
        create: (input: CreateShopInput) =>
          raw<ShopDetail>('/admin/shops', { method: 'POST', body: input }),
        update: (id: string, input: UpdateShopInput) =>
          raw<ShopDetail>(`/admin/shops/${id}`, { method: 'PATCH', body: input }),
        setHours: (id: string, input: ShopHoursInput) =>
          raw<ShopDetail>(`/admin/shops/${id}/hours`, { method: 'PUT', body: input })
      },

      categories: {
        list: () => raw<{ items: Category[] }>('/admin/categories'),
        create: (input: CreateCategoryInput) =>
          raw<Category>('/admin/categories', { method: 'POST', body: input }),
        update: (id: string, input: UpdateCategoryInput) =>
          raw<Category>(`/admin/categories/${id}`, { method: 'PATCH', body: input })
      },

      products: {
        list: (query: {
          shopId?: string
          categoryId?: string
          q?: string
          includeInactive?: boolean
          cursor?: string
          limit?: number
        }) => raw<Page<Product>>('/admin/products', { query }),
        create: (input: CreateProductInput) =>
          raw<Product>('/admin/products', { method: 'POST', body: input }),
        update: (id: string, input: UpdateProductInput) =>
          raw<Product>(`/admin/products/${id}`, { method: 'PATCH', body: input })
      },

      orders: {
        list: (
          query: {
            prisonId?: string
            zoneId?: string
            shopId?: string
            fulfillmentStatus?: FulfillmentStatus
            paymentStatus?: PaymentStatus
            q?: string
            from?: number
            to?: number
            cursor?: string
            limit?: number
          } = {}
        ) => raw<Page<OrderSummary>>('/admin/orders', { query }),
        get: (id: string) => raw<OrderDetail>(`/admin/orders/${id}`),
        setFulfillment: (id: string, input: UpdateFulfillmentInput) =>
          raw<OrderDetail>(`/admin/orders/${id}/fulfillment`, { method: 'PATCH', body: input })
      }
    },

    prisons: {
      list: () => raw<{ items: PrisonSummary[] }>('/prisons'),
      get: (id: string) => raw<PrisonDetail>(`/prisons/${id}`)
    },

    settings: {
      public: () => raw<PublicSettings>('/settings/public')
    }
  }
}

export type ApiClient = ReturnType<typeof createApiClient>
