import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { bool, id, jsonText, timestamps, ts } from './_shared.js'

/**
 * Settings Registry. Every key is declared in code with a Zod schema + default
 * (modules/settings/registry.ts); unknown keys are rejected on write and
 * missing keys fall back to the declared default.
 */
export const settings = sqliteTable(
  'settings',
  {
    key: text('key').notNull(),
    valueJson: text('value_json').notNull(),
    scope: text('scope').$type<'global' | 'prison'>().notNull().default('global'),
    /** NULL for global scope. */
    scopeId: text('scope_id'),
    updatedBy: text('updated_by'),
    updatedAt: ts('updated_at')
      .notNull()
      .$defaultFn(() => Date.now())
  },
  (t) => [uniqueIndex('uq_settings_key_scope').on(t.key, t.scope, t.scopeId)]
)

export type AuditActorType = 'customer' | 'staff' | 'system'

/** Everything that touches money, letters, or inmate records lands here. */
export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: id(),
    actorType: text('actor_type').$type<AuditActorType>().notNull(),
    actorId: text('actor_id'),
    actorLabel: text('actor_label'),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: text('entity_id'),
    prisonId: text('prison_id'),
    beforeJson: text('before_json'),
    afterJson: text('after_json'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: ts('created_at')
      .notNull()
      .$defaultFn(() => Date.now())
  },
  (t) => [
    index('idx_audit_entity').on(t.entity, t.entityId, t.createdAt),
    index('idx_audit_actor').on(t.actorType, t.actorId, t.createdAt),
    index('idx_audit_created').on(t.createdAt)
  ]
)

export type JobStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'

/** SQLite is the queue. Claimed with BEGIN IMMEDIATE; no Redis anywhere. */
export const jobs = sqliteTable(
  'jobs',
  {
    id: id(),
    kind: text('kind').notNull(),
    payloadJson: jsonText<Record<string, unknown>>('payload_json'),
    runAt: ts('run_at').notNull(),
    status: text('status').$type<JobStatus>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    lockedAt: ts('locked_at'),
    lockedBy: text('locked_by'),
    lastError: text('last_error'),
    resultJson: text('result_json'),
    completedAt: ts('completed_at'),
    ...timestamps()
  },
  (t) => [
    index('idx_jobs_claim').on(t.status, t.runAt),
    index('idx_jobs_kind').on(t.kind, t.status, t.runAt)
  ]
)

/**
 * Human-facing sequence numbers (order_no, payment_no, …). Bumped with
 * UPDATE … RETURNING inside the same transaction as the row it numbers.
 */
export const counters = sqliteTable(
  'counters',
  {
    scope: text('scope').notNull(),
    period: text('period').notNull(),
    value: integer('value').notNull().default(0),
    updatedAt: ts('updated_at')
      .notNull()
      .$defaultFn(() => Date.now())
  },
  (t) => [uniqueIndex('uq_counters').on(t.scope, t.period)]
)

/**
 * In-app notification outbox. The console/line notifier adapters also write
 * here so the notification surface exists before LINE push does (Phase 7).
 */
export const notifications = sqliteTable(
  'notifications',
  {
    id: id(),
    audience: text('audience').$type<'customer' | 'staff'>().notNull(),
    recipientId: text('recipient_id').notNull(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    dataJson: text('data_json'),
    channel: text('channel').$type<'in_app' | 'line' | 'console'>().notNull().default('in_app'),
    isRead: bool('is_read', false),
    readAt: ts('read_at'),
    sentAt: ts('sent_at'),
    error: text('error'),
    ...timestamps()
  },
  (t) => [index('idx_notifications_recipient').on(t.audience, t.recipientId, t.createdAt)]
)

/** Per-identifier throttle counters (login attempts by username and by IP). */
export const rateLimits = sqliteTable(
  'rate_limits',
  {
    key: text('key').primaryKey(),
    count: integer('count').notNull().default(0),
    windowStart: ts('window_start').notNull(),
    blockedUntil: ts('blocked_until')
  },
  (t) => [index('idx_rate_limits_window').on(t.windowStart)]
)
