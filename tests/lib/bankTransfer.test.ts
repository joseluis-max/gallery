import { ObjectId } from 'mongodb';
import type { Db } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';
import {
  BANK_ACCOUNT,
  closeTransferReview,
  MAX_RECEIPTS_PER_ORDER,
  RECEIPT_MAX_BYTES,
  receiptStorageKey,
  submitTransfer,
  validateReceiptFile,
} from '../../src/lib/bankTransfer.ts';
import { isSafeObjectKey } from '../../src/lib/storageKeys.ts';

function makeMockDb(config: { insertOneResult?: unknown; findOneAndUpdateResult?: unknown } = {}) {
  const collection = {
    insertOne: vi.fn().mockResolvedValue(config.insertOneResult ?? { insertedId: new ObjectId() }),
    updateMany: vi.fn().mockResolvedValue({}),
    findOneAndUpdate: vi.fn().mockResolvedValue(config.findOneAndUpdateResult ?? null),
    findOne: vi.fn().mockResolvedValue(null),
    countDocuments: vi.fn().mockResolvedValue(0),
  };
  const db = { collection: vi.fn(() => collection) } as unknown as Db;
  return { db, collection };
}

const receipt = { key: 'receipts/abc/def.jpg', filename: 'comprobante.jpg', contentType: 'image/jpeg', bytes: 1024 };

describe('validateReceiptFile', () => {
  it('accepts every type on the allowlist', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']) {
      expect(validateReceiptFile({ size: 1000, type })).toBeNull();
    }
  });

  // The submit path is reachable by anyone holding a pending order id, so "anything the
  // browser labelled an image" is not good enough — an allowlist is the whole defence.
  it('rejects a type that is not on the allowlist', () => {
    expect(validateReceiptFile({ size: 1000, type: 'text/html' })).toBe('RECEIPT_TYPE_NOT_ALLOWED');
    expect(validateReceiptFile({ size: 1000, type: 'application/x-msdownload' })).toBe('RECEIPT_TYPE_NOT_ALLOWED');
    expect(validateReceiptFile({ size: 1000, type: '' })).toBe('RECEIPT_TYPE_NOT_ALLOWED');
  });

  it('rejects an empty file, which is what an untouched file input submits', () => {
    expect(validateReceiptFile({ size: 0, type: 'image/jpeg' })).toBe('RECEIPT_REQUIRED');
  });

  it('rejects anything over the size cap, and accepts exactly the cap', () => {
    expect(validateReceiptFile({ size: RECEIPT_MAX_BYTES + 1, type: 'image/jpeg' })).toBe('RECEIPT_TOO_LARGE');
    expect(validateReceiptFile({ size: RECEIPT_MAX_BYTES, type: 'image/jpeg' })).toBeNull();
  });
});

describe('receiptStorageKey', () => {
  // The buyer names the file, so the guarantee that matters is that nothing they name it
  // can reach the key — the extension comes from the checked content type instead.
  it('builds the key from the order id, a random id and the content type, never the filename', () => {
    const key = receiptStorageKey('68c0f0f0f0f0f0f0f0f0f0f0', '11112222-3333-4444-5555-666677778888', 'application/pdf');
    expect(key).toBe('receipts/68c0f0f0f0f0f0f0f0f0f0f0/11112222-3333-4444-5555-666677778888.pdf');
  });

  it('produces keys the local driver will accept, for every allowed type', () => {
    const orderId = new ObjectId().toString();
    for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']) {
      expect(isSafeObjectKey(receiptStorageKey(orderId, '11112222-3333-4444-5555-666677778888', type))).toBe(true);
    }
  });

  it('stores an unknown type under a neutral extension rather than none at all', () => {
    // Unreachable through the action (validation runs first), but a key without an
    // extension is the kind of thing that silently becomes a directory later.
    expect(receiptStorageKey('order', 'id', 'application/zip')).toBe('receipts/order/id.bin');
  });
});

describe('submitTransfer', () => {
  it('demotes any earlier in-review submission before inserting the new one', async () => {
    const orderId = new ObjectId();
    const { db, collection } = makeMockDb();

    await submitTransfer(db, { orderId, amountCents: 600, lang: 'es', receipt });

    expect(collection.updateMany).toHaveBeenCalledWith(
      { orderId, status: 'in-review' },
      { $set: { status: 'superseded' } },
    );
    // Order matters: the reverse would leave a window in which the queue shows two rows
    // for one order.
    expect(collection.updateMany.mock.invocationCallOrder[0]).toBeLessThan(collection.insertOne.mock.invocationCallOrder[0]);
  });

  it('inserts as in-review with the amount and locale snapshotted', async () => {
    const orderId = new ObjectId();
    const { db, collection } = makeMockDb();

    const doc = await submitTransfer(db, { orderId, amountCents: 600, lang: 'en', reference: 'DOC-99', receipt });

    const inserted = collection.insertOne.mock.calls[0][0];
    expect(inserted.status).toBe('in-review');
    expect(inserted.amountCents).toBe(600);
    expect(inserted.lang).toBe('en');
    expect(inserted.reference).toBe('DOC-99');
    expect(inserted.receipt).toEqual(receipt);
    expect(doc._id).toBeInstanceOf(ObjectId);
  });

  it('omits the reference entirely when the buyer left it blank', async () => {
    const { db, collection } = makeMockDb();

    await submitTransfer(db, { orderId: new ObjectId(), amountCents: 600, lang: 'es', receipt });

    expect('reference' in collection.insertOne.mock.calls[0][0]).toBe(false);
  });
});

describe('closeTransferReview', () => {
  // The filter is the concurrency control: two admins working the queue, or one
  // double-click, must resolve to exactly one decision.
  it('only closes a submission that is still in review', async () => {
    const id = new ObjectId();
    const { db, collection } = makeMockDb({ findOneAndUpdateResult: { _id: id, status: 'approved' } });

    await closeTransferReview(db, id, { status: 'approved', reviewedBy: 'jose@example.com' });

    const [filter, update] = collection.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: id, status: 'in-review' });
    expect(update.$set.status).toBe('approved');
    expect(update.$set.reviewedBy).toBe('jose@example.com');
    expect(update.$set.reviewedAt).toBeInstanceOf(Date);
  });

  it('returns null when someone else already decided', async () => {
    const { db } = makeMockDb({ findOneAndUpdateResult: null });

    expect(await closeTransferReview(db, new ObjectId(), { status: 'approved', reviewedBy: 'a@b.c' })).toBeNull();
  });

  it('records the rejection reason, which is what the buyer is emailed', async () => {
    const id = new ObjectId();
    const { db, collection } = makeMockDb({ findOneAndUpdateResult: { _id: id } });

    await closeTransferReview(db, id, { status: 'rejected', reviewedBy: 'a@b.c', rejectionReason: 'Amount is short by $2' });

    expect(collection.findOneAndUpdate.mock.calls[0][1].$set.rejectionReason).toBe('Amount is short by $2');
  });
});

describe('BANK_ACCOUNT', () => {
  // These six values are the entire point of the feature: money typed against a wrong
  // digit goes to a stranger, and nothing downstream would notice.
  it('carries the account buyers are told to pay into', () => {
    expect(BANK_ACCOUNT.bank).toBe('Banco Pichincha');
    expect(BANK_ACCOUNT.accountNumber).toBe('2208996600');
    expect(BANK_ACCOUNT.idNumber).toBe('0150454320');
    expect(BANK_ACCOUNT.holder).toBe('José Luis Valdiviezo Peña');
    expect(BANK_ACCOUNT.accountType.es).toBe('Cuenta de ahorro transaccional');
    expect(BANK_ACCOUNT.accountType.en).toBeTruthy();
  });
});

describe('MAX_RECEIPTS_PER_ORDER', () => {
  it('leaves room for honest retries without being an open upload endpoint', () => {
    expect(MAX_RECEIPTS_PER_ORDER).toBeGreaterThan(1);
    expect(MAX_RECEIPTS_PER_ORDER).toBeLessThan(20);
  });
});
