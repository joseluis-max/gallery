import { ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { serializeForAction } from '../../src/lib/serialize.ts';

describe('serializeForAction', () => {
  it('converts ObjectId to string', () => {
    const id = new ObjectId();
    expect(serializeForAction(id)).toBe(id.toString());
  });

  it('converts nested ObjectId fields inside objects and arrays', () => {
    const id1 = new ObjectId();
    const id2 = new ObjectId();
    const result = serializeForAction({ _id: id1, items: [{ photoId: id2 }] });
    expect(result).toEqual({ _id: id1.toString(), items: [{ photoId: id2.toString() }] });
  });

  it('leaves Date instances untouched (devalue supports them natively)', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    const result = serializeForAction({ createdAt: date }) as { createdAt: Date };
    expect(result.createdAt).toBe(date);
  });

  it('leaves primitives and plain objects untouched', () => {
    expect(serializeForAction(42)).toBe(42);
    expect(serializeForAction('hi')).toBe('hi');
    expect(serializeForAction(null)).toBe(null);
    expect(serializeForAction({ a: 1, b: 'x' })).toEqual({ a: 1, b: 'x' });
  });
});
