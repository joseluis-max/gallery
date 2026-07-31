import { describe, expect, it } from 'vitest';
import { addCartItem, clearCart, removeCartItem, updateCartItemQty } from '../../src/lib/cart.ts';

describe('cart', () => {
  it('addCartItem assigns a unique lineId', () => {
    let cart = addCartItem([], { photoId: 'p1', type: 'print', qty: 1, widthCm: 30, heightCm: 20, paper: 'matte' });
    cart = addCartItem(cart, { photoId: 'p2', type: 'digital', qty: 1 });
    expect(cart).toHaveLength(2);
    expect(cart[0].lineId).not.toBe(cart[1].lineId);
  });

  it('removeCartItem removes only the matching line', () => {
    const cart = [
      { lineId: 'a', photoId: 'p1', type: 'print' as const, qty: 1 },
      { lineId: 'b', photoId: 'p2', type: 'digital' as const, qty: 1 },
    ];
    expect(removeCartItem(cart, 'a')).toEqual([cart[1]]);
  });

  it('updateCartItemQty updates only the matching line, leaves others untouched', () => {
    const cart = [
      { lineId: 'a', photoId: 'p1', type: 'print' as const, qty: 1 },
      { lineId: 'b', photoId: 'p2', type: 'digital' as const, qty: 1 },
    ];
    const updated = updateCartItemQty(cart, 'a', 5);
    expect(updated[0].qty).toBe(5);
    expect(updated[1].qty).toBe(1);
  });

  it('clearCart returns an empty array', () => {
    expect(clearCart()).toEqual([]);
  });
});
