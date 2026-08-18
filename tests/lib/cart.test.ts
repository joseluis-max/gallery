import { describe, expect, it } from 'vitest';
import { addCartItem, clearCart, hasCartItem, removeCartItem } from '../../src/lib/cart.ts';

describe('cart', () => {
  it('addCartItem assigns a unique lineId', () => {
    let cart = addCartItem([], { photoId: 'p1' });
    cart = addCartItem(cart, { photoId: 'p2' });
    expect(cart).toHaveLength(2);
    expect(cart[0].lineId).not.toBe(cart[1].lineId);
  });

  it('removeCartItem removes only the matching line', () => {
    const cart = [
      { lineId: 'a', photoId: 'p1' },
      { lineId: 'b', photoId: 'p2' },
    ];
    expect(removeCartItem(cart, 'a')).toEqual([cart[1]]);
  });

  describe('hasCartItem', () => {
    const cart = [
      { lineId: 'a', photoId: 'p1' },
      { lineId: 'b', photoId: 'p2' },
    ];

    it('is true for a photo already in the cart', () => {
      expect(hasCartItem(cart, 'p2')).toBe(true);
    });

    it('is false for a photo that is not', () => {
      expect(hasCartItem(cart, 'p3')).toBe(false);
    });

    // This is what stops a second purchase of a file the buyer already owns: one order
    // line mints one download token, so a duplicate line would charge twice for the
    // identical download.
    it('is false for an empty cart', () => {
      expect(hasCartItem([], 'p1')).toBe(false);
    });
  });

  it('clearCart returns an empty array', () => {
    expect(clearCart()).toEqual([]);
  });
});
