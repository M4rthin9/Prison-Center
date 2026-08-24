import { ulid } from 'ulid'
export { ulid }

export const newId = () => ulid()

/** Monotonic within a millisecond — use when insertion order must be stable. */
export const isUlid = (v: string) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(v)
