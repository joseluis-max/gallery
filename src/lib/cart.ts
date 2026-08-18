// Pure functions over the session-stored CartItem[] (see src/env.d.ts) — no session or
// Mongo dependency, so cart manipulation logic is unit-testable on its own.
export function addCartItem(cart: CartItem[], item: Omit<CartItem, 'lineId'>): CartItem[] {
  return [...cart, { ...item, lineId: crypto.randomUUID() }];
}

export function removeCartItem(cart: CartItem[], lineId: string): CartItem[] {
  return cart.filter((item) => item.lineId !== lineId);
}

/** A digital file has no quantity, so the cart dedupes on add instead of counting: buying
 *  the same photo twice would deliver the same single download token anyway. */
export function hasCartItem(cart: CartItem[], photoId: string): boolean {
  return cart.some((item) => item.photoId === photoId);
}

export function clearCart(): CartItem[] {
  return [];
}
