import type { LinkedInmate, Product } from '@pc/contract'

export type { LinkedInmate }

export interface CartLine {
  product: Product
  qty: number
}

/**
 * One cart, in memory only. It is deliberately not persisted: prices, stock and
 * shop hours all change server-side, and a cart restored from last week would
 * show a total the server will not honour.
 *
 * A cart belongs to exactly one shop — orders are placed per shop.
 */
class Cart {
  inmate = $state<LinkedInmate | null>(null)
  shopId = $state<string | null>(null)
  shopName = $state('')
  lines = $state<CartLine[]>([])

  readonly count = $derived(this.lines.reduce((n, l) => n + l.qty, 0))
  readonly subtotalSatang = $derived(
    this.lines.reduce((sum, l) => sum + l.product.priceSatang * l.qty, 0)
  )
  readonly isEmpty = $derived(this.lines.length === 0)

  qtyOf(productId: string) {
    return this.lines.find((l) => l.product.id === productId)?.qty ?? 0
  }

  /** Returns 'replaced' when the cart belonged to a different shop. */
  add(product: Product, shopName: string, qty = 1): 'added' | 'replaced' {
    let outcome: 'added' | 'replaced' = 'added'
    if (this.shopId !== product.shopId) {
      this.lines = []
      outcome = this.shopId === null ? 'added' : 'replaced'
      this.shopId = product.shopId
      this.shopName = shopName
    }

    const existing = this.lines.find((l) => l.product.id === product.id)
    const cap = product.maxPerOrder > 0 ? product.maxPerOrder : 99
    if (existing) existing.qty = Math.min(cap, existing.qty + qty)
    else this.lines.push({ product, qty: Math.min(cap, qty) })
    return outcome
  }

  setQty(productId: string, qty: number) {
    const line = this.lines.find((l) => l.product.id === productId)
    if (!line) return
    const cap = line.product.maxPerOrder > 0 ? line.product.maxPerOrder : 99
    const next = Math.max(0, Math.min(cap, qty))
    if (next === 0) this.remove(productId)
    else line.qty = next
  }

  remove(productId: string) {
    this.lines = this.lines.filter((l) => l.product.id !== productId)
    if (this.lines.length === 0) this.shopId = null
  }

  clear() {
    this.lines = []
    this.shopId = null
    this.shopName = ''
  }

  /** The exact payload POST /orders expects — quantities only, never prices. */
  toOrderInput(note?: string) {
    return {
      inmateId: this.inmate!.inmateId,
      shopId: this.shopId!,
      items: this.lines.map((l) => ({ productId: l.product.id, qty: l.qty })),
      note: note?.trim() ? note.trim() : undefined
    }
  }
}

export const cart = new Cart()
