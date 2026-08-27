import { ApiError, type ErrorCode } from './common.js'
import type {
  AdminMeResponse,
  ChangePasswordInput,
  LineLinkState,
  LineTokenInput,
  LoginInput,
  MeResponse,
  PasswordResetChallenge,
  PasswordResetRequestInput,
  PasswordResetVerifyInput,
  RegisterInput,
  SessionResponse,
  UpdateMeInput
} from './auth.js'
import type { InmateStatus, PrisonDetail, PrisonSummary } from './facility.js'
import type {
  CreateInmateInput,
  ImportPreview,
  ImportRowResult,
  ImportRowView,
  ImportRunSummary,
  InmateRow,
  MissingPolicy,
  TransferInmateInput,
  UpdateInmateInput
} from './inmates.js'
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
import type {
  CreatePaymentChannelInput,
  CreatePaymentInput,
  PaymentChannel,
  PaymentChannelPublic,
  PaymentDetail,
  PaymentPurpose,
  PaymentRail,
  PaymentState,
  PaymentSummary,
  PaymentView,
  RefundPaymentInput,
  RejectPaymentInput,
  SlipUploadResult,
  UpdatePaymentChannelInput,
  VerifyPaymentInput
} from './payments.js'
import type {
  CreateDepositCardInput,
  CreateDepositInput,
  DepositCard,
  DepositCardStatus,
  DepositDetail,
  DepositStatus,
  DepositSummary,
  DepositSummaryTotals,
  ReviewDepositCardInput,
  ReviewDepositInput
} from './deposits.js'
import type {
  CreateLetterBatchInput,
  CreateLetterInput,
  CreateLetterPackageInput,
  LetterBatch,
  LetterCredits,
  LetterDetail,
  LetterDirection,
  LetterPackage,
  LetterPurchaseDetail,
  LetterPurchaseSummary,
  LetterStatus,
  LetterSummary,
  LetterSummaryTotals,
  PurchaseLetterPackageInput,
  ScanReplyResult,
  UpdateLetterPackageInput,
  UpdateLetterStatusInput
} from './letters.js'
import type {
  CloseVisitDatesInput,
  CreateVisitBookingInput,
  CreateVisitRoundInput,
  CreateVisitScheduleDayInput,
  GenerateVisitScheduleInput,
  GenerateVisitScheduleResult,
  UpdateVisitBookingStatusInput,
  UpdateVisitRoundInput,
  UpdateVisitScheduleDayInput,
  UpsertVisitTemplateInput,
  VisitAvailability,
  VisitBookingDetail,
  VisitBookingStatus,
  VisitBookingSummary,
  VisitRound,
  VisitScheduleDay,
  VisitScheduleGrid,
  VisitSummaryTotals,
  VisitTemplateCell
} from './visits.js'
import type {
  CreateNewsInput,
  NewsDetail,
  NewsStatus,
  NewsSummary,
  UpdateNewsInput
} from './news.js'
import type { DashboardPeriod, DashboardSummary } from './dashboard.js'
import type { RetentionReport, RunRetentionInput } from './pdpa.js'
import type { ReportJob, ReportKind, ReportRequestInput } from './reports.js'
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
      },

      /* LINE + self-service reset — customer realm only. */

      lineLogin: (input: LineTokenInput) =>
        raw<SessionResponse>('/auth/line/login', {
          method: 'POST',
          body: input,
          retryOn401: false
        }).then(adopt),
      linkLine: (input: LineTokenInput) =>
        raw<LineLinkState>('/auth/line/link', { method: 'POST', body: input }),
      unlinkLine: () => raw<LineLinkState>('/auth/line/link', { method: 'DELETE' }),
      requestPasswordReset: (input: PasswordResetRequestInput) =>
        raw<PasswordResetChallenge>('/auth/password-reset/request', {
          method: 'POST',
          body: input,
          retryOn401: false
        }),
      verifyPasswordReset: (input: PasswordResetVerifyInput) =>
        raw<void>('/auth/password-reset/verify', {
          method: 'POST',
          body: input,
          retryOn401: false
        })
    },

    me: {
      get: () => raw<MeResponse>('/me'),
      update: (input: UpdateMeInput) => raw<MeResponse>('/me', { method: 'PATCH', body: input }),
      /** PDPA deletion request. Ends the session; the scrub happens later. */
      closeAccount: () => raw<void>('/me/close-account', { method: 'POST' })
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
      get: (id: string) => raw<OrderDetail>(`/orders/${id}`),
      /** Asking twice while the QR is alive returns the same one, not a second. */
      pay: (id: string, input: CreatePaymentInput = {}) =>
        raw<PaymentView>(`/orders/${id}/payment`, { method: 'POST', body: input })
    },

    payments: {
      channels: (query: { prisonId: string; purpose?: PaymentPurpose }) =>
        raw<{ items: PaymentChannelPublic[] }>('/payment-channels', { query }),
      list: (query: { cursor?: string; limit?: number } = {}) =>
        raw<Page<PaymentView>>('/payments', { query }),
      get: (id: string) => raw<PaymentView>(`/payments/${id}`),
      uploadSlip(id: string, file: File | Blob, filename = 'slip.jpg') {
        const form = new FormData()
        form.append('file', file, filename)
        return raw<SlipUploadResult>(`/payments/${id}/slip`, { method: 'POST', form })
      },
      slipUrl: (id: string) => url(`/payments/${id}/slip`)
    },

    deposits: {
      /** Creates the deposit *and* its QR in one call. */
      create: (input: CreateDepositInput) =>
        raw<DepositDetail>('/deposits', { method: 'POST', body: input }),
      list: (query: { cursor?: string; limit?: number; status?: DepositStatus } = {}) =>
        raw<Page<DepositSummary>>('/deposits', { query }),
      get: (id: string) => raw<DepositDetail>(`/deposits/${id}`),
      /** A fresh QR for the same deposit — never a second deposit. */
      pay: (id: string, input: { channelId?: string } = {}) =>
        raw<DepositDetail>(`/deposits/${id}/payment`, { method: 'POST', body: input }),
      cancel: (id: string) => raw<DepositDetail>(`/deposits/${id}/cancel`, { method: 'POST' }),
      cards: () => raw<{ items: DepositCard[] }>('/deposit-cards'),
      requestCard: (input: CreateDepositCardInput) =>
        raw<DepositCard>('/deposit-cards', { method: 'POST', body: input })
    },

    letters: {
      /** Balance is always read from the ledger — never cached client-side. */
      credits: () => raw<LetterCredits>('/letters/credits'),
      packages: (query: { prisonId?: string; direction?: LetterDirection } = {}) =>
        raw<{ items: LetterPackage[] }>('/letter-packages', { query }),
      purchase: (packageId: string, input: PurchaseLetterPackageInput = {}) =>
        raw<LetterPurchaseDetail>(`/letter-packages/${packageId}/purchase`, {
          method: 'POST',
          body: input
        }),
      purchases: (query: { cursor?: string; limit?: number } = {}) =>
        raw<Page<LetterPurchaseSummary>>('/letter-purchases', { query }),
      purchaseGet: (id: string) => raw<LetterPurchaseDetail>(`/letter-purchases/${id}`),
      /** A fresh QR for the same purchase — never a second purchase. */
      purchasePay: (id: string, input: { channelId?: string } = {}) =>
        raw<LetterPurchaseDetail>(`/letter-purchases/${id}/payment`, {
          method: 'POST',
          body: input
        }),

      list: (
        query: {
          cursor?: string
          limit?: number
          direction?: LetterDirection
          status?: LetterStatus
        } = {}
      ) => raw<Page<LetterSummary>>('/letters', { query }),
      get: (id: string) => raw<LetterDetail>(`/letters/${id}`),
      /** A draft costs nothing; `submit` is what spends the coupon. */
      create: (input: CreateLetterInput) =>
        raw<LetterDetail>('/letters', { method: 'POST', body: input }),
      update: (id: string, bodyText: string) =>
        raw<LetterDetail>(`/letters/${id}`, { method: 'PATCH', body: { bodyText } }),
      addAttachment(id: string, file: File | Blob, filename = 'photo.jpg') {
        const form = new FormData()
        form.append('file', file, filename)
        return raw<LetterDetail>(`/letters/${id}/attachments`, { method: 'POST', form })
      },
      removeAttachment: (id: string, attachmentId: string) =>
        raw<LetterDetail>(`/letters/${id}/attachments/${attachmentId}`, { method: 'DELETE' }),
      submit: (id: string) => raw<LetterDetail>(`/letters/${id}/submit`, { method: 'POST' }),
      cancel: (id: string) => raw<LetterDetail>(`/letters/${id}/cancel`, { method: 'POST' }),
      scanUrl: (id: string) => url(`/letters/${id}/scan`),
      attachmentUrl: (id: string, attachmentId: string) =>
        url(`/letters/${id}/attachments/${attachmentId}`)
    },

    visits: {
      rounds: (prisonId: string) => raw<{ items: VisitRound[] }>('/visits/rounds', { query: { prisonId } }),
      /** Reads the materialized calendar only — never a weekday rule. */
      availability: (inmateId: string, query: { from?: string; to?: string } = {}) =>
        raw<VisitAvailability>('/visits/availability', { query: { inmateId, ...query } }),
      book: (input: CreateVisitBookingInput) =>
        raw<VisitBookingDetail>('/visits', { method: 'POST', body: input }),
      list: (query: { cursor?: string; limit?: number; status?: VisitBookingStatus } = {}) =>
        raw<Page<VisitBookingSummary>>('/visits', { query }),
      get: (id: string) => raw<VisitBookingDetail>(`/visits/${id}`),
      cancel: (id: string, reason?: string) =>
        raw<VisitBookingDetail>(`/visits/${id}/cancel`, { method: 'POST', body: { reason } })
    },

    admin: {
      me: () => raw<AdminMeResponse>('/admin/me'),

      /** p.11 — one call feeds all four tiles and the period chart. */
      dashboard: (
        query: { prisonId?: string; period?: DashboardPeriod; from?: string; to?: string } = {}
      ) => raw<DashboardSummary>('/admin/dashboard/summary', { query }),

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
      },

      inmates: {
        list: (
          query: {
            prisonId?: string
            zoneId?: string
            status?: InmateStatus
            q?: string
            includeDeleted?: boolean
            cursor?: string
            limit?: number
          } = {}
        ) => raw<Page<InmateRow>>('/admin/inmates', { query }),
        get: (id: string) => raw<InmateRow>(`/admin/inmates/${id}`),
        create: (input: CreateInmateInput) =>
          raw<InmateRow>('/admin/inmates', { method: 'POST', body: input }),
        update: (id: string, input: UpdateInmateInput) =>
          raw<InmateRow>(`/admin/inmates/${id}`, { method: 'PATCH', body: input }),
        transfer: (id: string, input: TransferInmateInput) =>
          raw<InmateRow>(`/admin/inmates/${id}/transfer`, { method: 'POST', body: input }),
        remove: (id: string) => raw<InmateRow>(`/admin/inmates/${id}`, { method: 'DELETE' }),
        restore: (id: string) => raw<InmateRow>(`/admin/inmates/${id}/restore`, { method: 'POST' }),

        /** Step one: never writes. The preview is the diff a human signs off. */
        dryRun(
          file: File | Blob,
          opts: {
            prisonId?: string
            source?: string
            createZones?: boolean
            missingPolicy?: MissingPolicy
            filename?: string
          } = {}
        ) {
          const form = new FormData()
          form.append('file', file, opts.filename ?? 'inmates.xlsx')
          if (opts.prisonId) form.append('prisonId', opts.prisonId)
          if (opts.source) form.append('source', opts.source)
          form.append('createZones', String(opts.createZones ?? false))
          form.append('missingPolicy', opts.missingPolicy ?? 'ignore')
          return raw<ImportPreview>('/admin/inmates/import', { method: 'POST', form })
        },
        apply: (runId: string) =>
          raw<ImportPreview>(`/admin/inmates/import/${runId}/apply`, { method: 'POST' }),
        runs: (query: { prisonId?: string; limit?: number } = {}) =>
          raw<{ items: ImportRunSummary[] }>('/admin/inmates/import-runs', { query }),
        run: (runId: string, query: { result?: ImportRowResult; limit?: number } = {}) =>
          raw<{ run: ImportRunSummary; rows: ImportRowView[] }>(
            `/admin/inmates/import-runs/${runId}`,
            { query }
          ),
        errorReportUrl: (runId: string) => url(`/admin/inmates/import-runs/${runId}/errors.xlsx`)
      },

      deposits: {
        list: (
          query: {
            prisonId?: string
            status?: DepositStatus
            q?: string
            from?: number
            to?: number
            cursor?: string
            limit?: number
          } = {}
        ) => raw<Page<DepositSummary>>('/admin/deposits', { query }),
        get: (id: string) => raw<DepositDetail>(`/admin/deposits/${id}`),
        review: (id: string, input: ReviewDepositInput) =>
          raw<DepositDetail>(`/admin/deposits/${id}/review`, { method: 'POST', body: input }),
        summary: (query: { prisonId?: string; from?: number; to?: number } = {}) =>
          raw<DepositSummaryTotals>('/admin/deposits/summary', { query }),
        cards: (query: { prisonId?: string; status?: DepositCardStatus; limit?: number } = {}) =>
          raw<{ items: DepositCard[] }>('/admin/deposit-cards', { query }),
        reviewCard: (id: string, input: ReviewDepositCardInput) =>
          raw<DepositCard>(`/admin/deposit-cards/${id}/review`, { method: 'POST', body: input })
      },

      letters: {
        list: (
          query: {
            prisonId?: string
            zoneId?: string
            status?: LetterStatus
            direction?: LetterDirection
            batchId?: string
            q?: string
            from?: number
            to?: number
            cursor?: string
            limit?: number
          } = {}
        ) => raw<Page<LetterSummary>>('/admin/letters', { query }),
        get: (id: string) => raw<LetterDetail>(`/admin/letters/${id}`),
        summary: (query: { prisonId?: string; from?: number; to?: number } = {}) =>
          raw<LetterSummaryTotals>('/admin/letters/summary', { query }),
        setStatus: (id: string, input: UpdateLetterStatusInput) =>
          raw<LetterDetail>(`/admin/letters/${id}/status`, { method: 'POST', body: input }),
        scanUrl: (id: string) => url(`/admin/letters/${id}/scan`),

        batches: (query: { prisonId?: string; limit?: number } = {}) =>
          raw<{ items: LetterBatch[] }>('/admin/letters/batches', { query }),
        batch: (id: string) => raw<LetterBatch>(`/admin/letters/batches/${id}`),
        createBatch: (input: CreateLetterBatchInput = {}) =>
          raw<LetterBatch>('/admin/letters/batches', { method: 'POST', body: input }),
        markBatchPrinted: (id: string) =>
          raw<LetterBatch>(`/admin/letters/batches/${id}/printed`, { method: 'POST' }),
        batchFileUrl: (id: string) => url(`/admin/letters/batches/${id}/file`),

        /** The QR on the sheet is read server-side; `letterNo` is the fallback. */
        scanReply(file: File | Blob, opts: { letterNo?: string } = {}) {
          const form = new FormData()
          form.append('file', file, 'reply.jpg')
          if (opts.letterNo) form.append('letterNo', opts.letterNo)
          return raw<ScanReplyResult>('/admin/letters/scan-reply', { method: 'POST', form })
        },

        packages: (query: { prisonId?: string; includeInactive?: boolean } = {}) =>
          raw<{ items: LetterPackage[] }>('/admin/letter-packages', { query }),
        createPackage: (input: CreateLetterPackageInput) =>
          raw<LetterPackage>('/admin/letter-packages', { method: 'POST', body: input }),
        updatePackage: (id: string, input: UpdateLetterPackageInput) =>
          raw<LetterPackage>(`/admin/letter-packages/${id}`, { method: 'PATCH', body: input })
      },

      visits: {
        rounds: (query: { prisonId?: string; includeInactive?: boolean } = {}) =>
          raw<{ items: VisitRound[] }>('/admin/visit-rounds', { query }),
        createRound: (input: CreateVisitRoundInput) =>
          raw<VisitRound>('/admin/visit-rounds', { method: 'POST', body: input }),
        updateRound: (id: string, input: UpdateVisitRoundInput) =>
          raw<VisitRound>(`/admin/visit-rounds/${id}`, { method: 'PATCH', body: input }),
        deleteRound: (id: string) =>
          raw<{ ok: true }>(`/admin/visit-rounds/${id}`, { method: 'DELETE' }),

        templates: (query: { prisonId?: string } = {}) =>
          raw<{ items: VisitTemplateCell[] }>('/admin/visit-templates', { query }),
        setTemplate: (input: UpsertVisitTemplateInput) =>
          raw<VisitTemplateCell>('/admin/visit-templates', { method: 'PUT', body: input }),
        deleteTemplate: (id: string) =>
          raw<{ ok: true }>(`/admin/visit-templates/${id}`, { method: 'DELETE' }),

        /** The week grid: rounds down the left, dates across the top. */
        schedule: (query: { prisonId?: string; from?: string; to?: string } = {}) =>
          raw<VisitScheduleGrid>('/admin/visit-schedule', { query }),
        createDay: (input: CreateVisitScheduleDayInput) =>
          raw<VisitScheduleDay>('/admin/visit-schedule', { method: 'POST', body: input }),
        updateDay: (id: string, input: UpdateVisitScheduleDayInput) =>
          raw<VisitScheduleDay>(`/admin/visit-schedule/${id}`, { method: 'PATCH', body: input }),
        deleteDay: (id: string) =>
          raw<{ ok: true }>(`/admin/visit-schedule/${id}`, { method: 'DELETE' }),
        /** Safe to press twice: existing cells are never touched. */
        generate: (input: GenerateVisitScheduleInput = {}) =>
          raw<GenerateVisitScheduleResult>('/admin/visit-schedule/generate', {
            method: 'POST',
            body: input
          }),
        closeDates: (input: CloseVisitDatesInput) =>
          raw<{ affected: number }>('/admin/visit-schedule/close', { method: 'POST', body: input }),

        list: (
          query: {
            prisonId?: string
            zoneId?: string
            status?: VisitBookingStatus
            date?: string
            from?: string
            to?: string
            q?: string
            cursor?: string
            limit?: number
          } = {}
        ) => raw<Page<VisitBookingSummary>>('/admin/visits', { query }),
        get: (id: string) => raw<VisitBookingDetail>(`/admin/visits/${id}`),
        setStatus: (id: string, input: UpdateVisitBookingStatusInput) =>
          raw<VisitBookingDetail>(`/admin/visits/${id}/status`, { method: 'POST', body: input }),
        checkIn: (id: string) =>
          raw<VisitBookingDetail>(`/admin/visits/${id}/check-in`, { method: 'POST' }),
        summary: (query: { prisonId?: string; from?: string; to?: string } = {}) =>
          raw<VisitSummaryTotals>('/admin/visits/summary', { query })
      },

      paymentChannels: {
        list: (query: { prisonId?: string; includeInactive?: boolean } = {}) =>
          raw<{ items: PaymentChannel[] }>('/admin/payment-channels', { query }),
        create: (input: CreatePaymentChannelInput) =>
          raw<PaymentChannel>('/admin/payment-channels', { method: 'POST', body: input }),
        update: (id: string, input: UpdatePaymentChannelInput) =>
          raw<PaymentChannel>(`/admin/payment-channels/${id}`, { method: 'PATCH', body: input })
      },

      payments: {
        list: (
          query: {
            prisonId?: string
            status?: PaymentState
            rail?: PaymentRail
            purpose?: PaymentPurpose
            channelId?: string
            q?: string
            from?: number
            to?: number
            cursor?: string
            limit?: number
          } = {}
        ) => raw<Page<PaymentSummary>>('/admin/payments', { query }),
        get: (id: string) => raw<PaymentDetail>(`/admin/payments/${id}`),
        verify: (id: string, input: VerifyPaymentInput) =>
          raw<PaymentDetail>(`/admin/payments/${id}/verify`, { method: 'POST', body: input }),
        reject: (id: string, input: RejectPaymentInput) =>
          raw<PaymentDetail>(`/admin/payments/${id}/reject`, { method: 'POST', body: input }),
        refund: (id: string, input: RefundPaymentInput) =>
          raw<PaymentDetail>(`/admin/payments/${id}/refund`, { method: 'POST', body: input }),
        slipUrl: (id: string) => url(`/admin/payments/${id}/slip`)
      },

      news: {
        list: (
          query: {
            prisonId?: string
            status?: NewsStatus
            q?: string
            cursor?: string
            limit?: number
          } = {}
        ) => raw<Page<NewsSummary>>('/admin/news', { query }),
        get: (id: string) => raw<NewsDetail>(`/admin/news/${id}`),
        create: (input: CreateNewsInput) =>
          raw<NewsDetail>('/admin/news', { method: 'POST', body: input }),
        update: (id: string, input: UpdateNewsInput) =>
          raw<NewsDetail>(`/admin/news/${id}`, { method: 'PATCH', body: input }),
        remove: (id: string) => raw<{ ok: true }>(`/admin/news/${id}`, { method: 'DELETE' }),
        setCover(id: string, file: File | Blob, filename = 'cover.jpg') {
          const form = new FormData()
          form.append('file', file, filename)
          return raw<NewsDetail>(`/admin/news/${id}/cover`, { method: 'POST', form })
        },
        removeCover: (id: string) =>
          raw<NewsDetail>(`/admin/news/${id}/cover`, { method: 'DELETE' })
      },

      reports: {
        /** Queues the job and returns immediately — XLSX is never inline. */
        run: (kind: ReportKind, input: ReportRequestInput) =>
          raw<ReportJob>(`/admin/reports/${kind}`, { method: 'POST', body: input }),
        list: (query: { kind?: ReportKind; limit?: number } = {}) =>
          raw<{ items: ReportJob[] }>('/admin/reports', { query }),
        get: (jobId: string) => raw<ReportJob>(`/admin/reports/${jobId}`),
        downloadUrl: (jobId: string) => url(`/admin/reports/${jobId}/download`)
      },

      pdpa: {
        /** Reports what the retention job would remove. Never deletes. */
        preview: () => raw<RetentionReport>('/admin/pdpa/retention/preview'),
        run: (input: RunRetentionInput = {}) =>
          raw<RetentionReport>('/admin/pdpa/retention/run', { method: 'POST', body: input })
      }
    },

    news: {
      /** Published only. No session needed — the feed is public by design. */
      list: (query: { prisonId?: string; cursor?: string; limit?: number } = {}) =>
        raw<Page<NewsSummary>>('/news', { query }),
      get: (slug: string) => raw<NewsDetail>(`/news/${encodeURIComponent(slug)}`)
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
