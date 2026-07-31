// Pure functions over the session-stored CartItem[] (see src/env.d.ts) — no session or
// Mongo dependency, so cart manipulation logic is unit-testable on its own.
export function addCartItem(cart: CartItem[], item: Omit<CartItem, 'lineId'>): CartItem[] {
  return [...cart, { ...item, lineId: crypto.randomUUID() }];
}

export function removeCartItem(cart: CartItem[], lineId: string): CartItem[] {
  return cart.filter((item) => item.lineId !== lineId);
}

export function updateCartItemQty(cart: CartItem[], lineId: string, qty: number): CartItem[] {
  return cart.map((item) => (item.lineId === lineId ? { ...item, qty } : item));
}

export function clearCart(): CartItem[] {
  return [];
}
