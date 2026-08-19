import { describe, expect, it, vi } from 'vitest';
import {
  confirmPayphonePayment,
  IVA_PERCENT,
  newClientTransactionId,
  PAYPHONE_CONFIRM_URL,
  splitAmountForIva,
} from '../../src/lib/payphone.ts';

describe('splitAmountForIva', () => {
  // Payphone rejects the transaction outright when the parts do not sum to `amount`, so
  // this is the load-bearing property of the whole module — asserted as a sweep rather
  // than three hand-picked examples, because a rounding bug here shows up on roughly half
  // of all totals and a handful of cases would sail straight past it.
  it('always satisfies amount === amountWithoutTax + amountWithTax + tax + service + tip', () => {
    for (let total = 1; total <= 5000; total++) {
      const a = splitAmountForIva(total);
      expect(a.amountWithoutTax + a.amountWithTax + a.tax + a.service + a.tip).toBe(total);
      expect(a.amount).toBe(total);
    }
  });

  it('holds the same identity for larger totals', () => {
    for (const total of [9999, 12_345, 100_000, 999_999]) {
      const a = splitAmountForIva(total);
      expect(a.amountWithoutTax + a.amountWithTax + a.tax + a.service + a.tip).toBe(total);
    }
  });

  it('splits an IVA-inclusive total into base and tax at the configured rate', () => {
    expect(IVA_PERCENT).toBe(15);
    // 200 / 1.15 = 173.91 -> 174 base, 26 tax
    expect(splitAmountForIva(200)).toMatchObject({ amountWithTax: 174, tax: 26 });
    // Exact cases, where the arithmetic is checkable by hand
    expect(splitAmountForIva(115)).toMatchObject({ amountWithTax: 100, tax: 15 });
    expect(splitAmountForIva(1150)).toMatchObject({ amountWithTax: 1000, tax: 150 });
    // The deepest volume tier, which is a real single-photo price
    expect(splitAmountForIva(120)).toMatchObject({ amountWithTax: 104, tax: 16 });
  });

  it('puts everything in the taxable base — prices are IVA-inclusive, and there is no service or tip', () => {
    const a = splitAmountForIva(750);
    expect(a.amountWithoutTax).toBe(0);
    expect(a.service).toBe(0);
    expect(a.tip).toBe(0);
  });

  it('never produces a negative tax, even at a one-cent total', () => {
    for (let total = 1; total <= 20; total++) {
      expect(splitAmountForIva(total).tax).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('newClientTransactionId', () => {
  const orderIdHex = '652f1a4b8c9d0e1f2a3b4c5d';

  it('fits inside Payphone’s 50-character limit', () => {
    expect(newClientTransactionId(orderIdHex).length).toBeLessThanOrEqual(50);
  });

  it('is the order id plus a random suffix', () => {
    expect(newClientTransactionId(orderIdHex)).toMatch(/^[0-9a-f]{24}-[0-9a-f]{16}$/);
    expect(newClientTransactionId(orderIdHex).startsWith(`${orderIdHex}-`)).toBe(true);
  });

  // A buyer who cancels and starts again must get a genuinely new id: Payphone requires
  // uniqueness per transaction, and the entropy is also what stops a third party from
  // guessing a live id and burning our terminal confirm.
  it('differs on every call for the same order', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newClientTransactionId(orderIdHex)));
    expect(ids.size).toBe(50);
  });
});

describe('confirmPayphonePayment', () => {
  const approved = {
    transactionId: 23178284,
    clientTransactionId: 'abc-123',
    statusCode: 3,
    transactionStatus: 'Approved',
    amount: 315,
  };

  function jsonResponse(status: number, body: unknown) {
    return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
  }

  it('POSTs to the confirm endpoint with the bearer token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, approved));

    await confirmPayphonePayment('tok_abc', { id: 23178284, clientTxId: 'abc-123' }, fetchImpl as never);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(PAYPHONE_CONFIRM_URL);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer tok_abc', 'Content-Type': 'application/json' });
  });

  // The wire field is `clientTxId`, while everything else in the integration calls it
  // `clientTransactionId`. Payphone answers a mismatched body with a "transaction not
  // found" that looks exactly like a genuine failure, so the exact shape is asserted.
  it('sends exactly { id, clientTxId } as the body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, approved));

    await confirmPayphonePayment('tok_abc', { id: 23178284, clientTxId: 'abc-123' }, fetchImpl as never);

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ id: 23178284, clientTxId: 'abc-123' });
  });

  it('returns ok with the parsed body on 200', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, approved));

    const result = await confirmPayphonePayment('tok_abc', { id: 1, clientTxId: 'abc-123' }, fetchImpl as never);

    expect(result.ok).toBe(true);
    expect(result.httpStatus).toBe(200);
    expect(result.body).toMatchObject({ statusCode: 3, amount: 315 });
  });

  // The caller's first job is to persist the outcome before acting on it, and an exception
  // is the one shape that cannot be persisted — so every failure mode has to come back as
  // a value.
  it('returns a failure result rather than throwing on a non-200', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(400, { message: 'Transaction not found', errorCode: 20 }));

    const result = await confirmPayphonePayment('tok_abc', { id: 1, clientTxId: 'abc-123' }, fetchImpl as never);

    expect(result.ok).toBe(false);
    expect(result.httpStatus).toBe(400);
    expect(result.body).toMatchObject({ errorCode: 20 });
  });

  it('returns httpStatus 0 rather than throwing when the request never gets an answer', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ETIMEDOUT'));

    const result = await confirmPayphonePayment('tok_abc', { id: 1, clientTxId: 'abc-123' }, fetchImpl as never);

    expect(result.ok).toBe(false);
    expect(result.httpStatus).toBe(0);
    expect(result.body.message).toBe('ETIMEDOUT');
  });

  it('treats a non-JSON body as a failure rather than throwing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    } as unknown as Response);

    const result = await confirmPayphonePayment('tok_abc', { id: 1, clientTxId: 'abc-123' }, fetchImpl as never);

    expect(result.ok).toBe(false);
    expect(result.httpStatus).toBe(502);
  });
});
