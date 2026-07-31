import { ObjectId } from 'mongodb';

/**
 * Astro Actions serialize return values with `devalue`, which natively supports Date,
 * Map, Set, RegExp, etc. — but NOT arbitrary class instances, including MongoDB's
 * `ObjectId` ("Cannot stringify arbitrary non-POJOs"). Any action returning a Mongo
 * document (or anything containing one) must run it through this first, or the action
 * call fails at the network boundary rather than in an obvious way.
 */
export function serializeForAction<T>(value: T): unknown {
  if (value instanceof ObjectId) return value.toString();
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((item) => serializeForAction(item));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = serializeForAction(val);
    }
    return out;
  }
  return value;
}
