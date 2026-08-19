// Pure gateway module — no Mongo, no Astro, no env reading. Everything here is a function
// of its arguments, so the amount arithmetic (the part that must never be wrong) is
// unit-testable with zero live services, and the confirm call is testable by passing a
// fake `fetch`.
//
// Deliberately NOT in pricing.ts: `computeCartPricing` is the single source of truth for
// *what the cart costs*, and nothing in this file changes that. The IVA split is only how
// one gateway wants the same total described on the wire. Putting Payphone's field names
// next to the price computation would invite a future reader to think tax is part of
// pricing. It isn't — storefront prices are IVA-inclusive and do not move.
import { randomBytes } from 'node:crypto';

/** Ecuador's IVA, as a whole percent. Named because it has changed before (12 → 15 in
 *  2024) and will change again. A rate change is this one line, and it cannot disturb an
 *  existing pending order: the split is recomputed from the *total* every time the
 *  checkout page renders, and the total is what it always was. */
export const IVA_PERCENT = 15;

export const PAYPHONE_CONFIRM_URL = 'https://paymentbox.payphonetodoesposible.com/api/confirm';

/** How long a rendered Cajita form stays valid, per Payphone's documentation. The checkout
 *  page counts down from this so the buyer is told the form died, rather than finding out
 *  by submitting into it. */
export const PAYPHONE_FORM_LIFETIME_MS = 10 * 60 * 1000;

/** Payphone reports an approved payment as statusCode 3; 2 is a cancellation. Those are
 *  the only two values the API documents. */
export const PAYPHONE_STATUS_APPROVED = 3;
export const PAYPHONE_STATUS_CANCELED = 2;

// Payphone enforces a MINIMUM transaction amount, but it is a per-merchant/contract figure
// rather than a published constant, so there is deliberately no number here yet. Confirm
// it with the Payphone account rep, then add PAYPHONE_MIN_AMOUNT_CENTS and raise the guard
// in the checkout action to match. This is not hypothetical: the default digital price is
// 200 and the deepest volume tier is 120, so a legitimate single-photo order lands in the
// $1.20–$2.00 range. Guessing the figure means choosing between rejecting real orders and
// letting the buyer meet a raw gateway error instead of something this store told them.

export interface PayphoneAmounts {
  amount: number;
  amountWithoutTax: number;
  amountWithTax: number;
  tax: number;
  service: number;
  tip: number;
}

/**
 * Splits an IVA-inclusive total into the parts Payphone's API demands.
 *
 * Payphone hard-requires `amount === amountWithoutTax + amountWithTax + tax + service +
 * tip` in integer cents and rejects the transaction outright otherwise. That holds here
 * **by construction, not by luck**: only the taxable base is rounded, and the tax is then
 * the residual. Rounding both independently is the classic way to be one cent off on
 * roughly half of all orders.
 *
 * `(total * 100) / (100 + IVA_PERCENT)` rather than `total / 1.15`: the numerator stays an
 * exact integer, so there is exactly one floating-point operation. And an exact `.5` tie —
 * the only case where Math.round's rounding mode would matter — is arithmetically
 * impossible: a tie requires `200 × total ≡ 115 (mod 230)`, and the left side is always
 * even while the right side is always odd.
 */
export function splitAmountForIva(totalCents: number): PayphoneAmounts {
  const amountWithTax = Math.round((totalCents * 100) / (100 + IVA_PERCENT));
  return {
    amount: totalCents,
    amountWithoutTax: 0,
    amountWithTax,
    tax: totalCents - amountWithTax,
    service: 0,
    tip: 0,
  };
}

/**
 * A fresh transaction id for one payment *attempt*.
 *
 * Two properties are load-bearing:
 *
 * 1. **Unique per attempt, not per order.** A buyer who cancels and starts again must get
 *    a new id — Payphone requires uniqueness, and reusing one would silently re-point a
 *    dead form at a live attempt.
 * 2. **Unguessable.** Payphone's confirm is *terminal*: whoever calls it first wins, and a
 *    second call errors. Since the Cajita hands the same bearer token to every browser
 *    that loads a checkout page (see the token note in config.ts), the 64 bits of entropy
 *    here are what stop a third party from burning our confirm and leaving a real buyer
 *    charged with nothing delivered.
 *
 * The order-id prefix is a **human convenience only** — it makes a row in Payphone's
 * merchant panel traceable back to an order without a database query. The confirm route
 * resolves the order by reading `orderId` off the stored attempt document, never by
 * parsing this string. There is deliberately no `parseOrderIdFrom…` helper: its existence
 * would be an invitation to accept a hand-crafted `<someoneElsesOrderId>-deadbeef`.
 *
 * 24 hex + 1 hyphen + 16 hex = 41 characters, inside Payphone's 50-character limit.
 */
export function newClientTransactionId(orderIdHex: string): string {
  return `${orderIdHex}-${randomBytes(8).toString('hex')}`;
}

/** The subset of Payphone's confirm response this app reads. Their payload carries more
 *  (bin, deferred, storeName, regionIso…); these are the fields that drive a decision or
 *  get shown to someone. */
export interface PayphoneConfirmResponse {
  transactionId: number;
  clientTransactionId: string;
  statusCode: number;
  transactionStatus: string;
  amount: number;
  currency?: string;
  authorizationCode?: string;
  email?: string;
  phoneNumber?: string;
  document?: string;
  cardBrand?: string;
  lastDigits?: string;
  message?: string | null;
  messageCode?: number;
  date?: string;
}

export interface PayphoneConfirmError {
  message?: string;
  errorCode?: number;
}

export type PayphoneConfirmResult =
  | { ok: true; httpStatus: number; body: PayphoneConfirmResponse }
  | { ok: false; httpStatus: number; body: PayphoneConfirmError };

/**
 * Executes the confirmation phase. This is the *only* authoritative statement about
 * whether a payment happened and for how much — the `id` and `clientTransactionId` that
 * arrive on the return redirect are query-string values, and an attacker can type anything
 * there.
 *
 * **Never throws.** A DNS failure, a timeout and a 500 all come back as `ok: false` with a
 * body, because the caller's first job is to *persist* the outcome before acting on it,
 * and an exception is the one shape that cannot be persisted. `httpStatus: 0` means the
 * request never got an answer at all.
 *
 * The 15-second abort matters more than it looks: Payphone reverses any transaction that
 * is not confirmed within five minutes, so a socket left hanging is strictly worse than a
 * fast, recorded failure that reconciliation can retry.
 *
 * Note the request field is **`clientTxId`**, not `clientTransactionId` — Payphone uses the
 * long name on the way out and the short one on the way back in.
 */
export async function confirmPayphonePayment(
  token: string,
  params: { id: number; clientTxId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<PayphoneConfirmResult> {
  let response: Response;
  try {
    response = await fetchImpl(PAYPHONE_CONFIRM_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: params.id, clientTxId: params.clientTxId }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { ok: false, httpStatus: 0, body: { message: err instanceof Error ? err.message : String(err) } };
  }

  // A non-JSON body is itself a failure signal (an HTML error page from a proxy, say), so
  // it is caught and reported rather than allowed to throw past the caller.
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = { message: `Non-JSON response (HTTP ${response.status})` };
  }

  if (!response.ok) {
    return { ok: false, httpStatus: response.status, body: body as PayphoneConfirmError };
  }
  return { ok: true, httpStatus: response.status, body: body as PayphoneConfirmResponse };
}
