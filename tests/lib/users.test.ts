import { ObjectId } from 'mongodb';
import type { Db } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';
import { hashPassword } from '../../src/lib/auth.ts';
import {
  assertValidCredentials,
  authenticateUser,
  createUser,
  isAdmin,
  isValidEmail,
  normalizeEmail,
  toSessionUser,
  updateProfile,
  UserError,
  type UserDoc,
} from '../../src/lib/users.ts';

function makeMockDb(config: { findOneResult?: unknown; insertOneResult?: unknown; insertOneError?: unknown; findOneAndUpdateResult?: unknown; findOneAndUpdateError?: unknown } = {}) {
  const collection = {
    findOne: vi.fn().mockResolvedValue(config.findOneResult ?? null),
    insertOne: config.insertOneError
      ? vi.fn().mockRejectedValue(config.insertOneError)
      : vi.fn().mockResolvedValue(config.insertOneResult ?? { insertedId: new ObjectId() }),
    findOneAndUpdate: config.findOneAndUpdateError
      ? vi.fn().mockRejectedValue(config.findOneAndUpdateError)
      : vi.fn().mockResolvedValue(config.findOneAndUpdateResult ?? null),
    updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
  };
  const db = { collection: vi.fn(() => collection) } as unknown as Db;
  return { db, collection };
}

function makeUser(overrides: Partial<UserDoc> = {}): UserDoc {
  return {
    _id: new ObjectId(),
    email: 'buyer@example.com',
    name: 'Buyer',
    passwordHash: hashPassword('correct-horse-battery'),
    role: 'customer',
    disabled: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('normalizeEmail / isValidEmail', () => {
  it('lowercases and trims, so casing never creates a second account', () => {
    expect(normalizeEmail('  Jose@Example.COM ')).toBe('jose@example.com');
  });

  it('accepts ordinary addresses and rejects obvious non-addresses', () => {
    expect(isValidEmail('jose@example.com')).toBe(true);
    expect(isValidEmail('jose+prints@sub.example.co.uk')).toBe(true);
    expect(isValidEmail('jose@example')).toBe(false);
    expect(isValidEmail('not-an-address')).toBe(false);
    expect(isValidEmail('two spaces@example.com')).toBe(false);
    expect(isValidEmail('')).toBe(false);
  });
});

describe('assertValidCredentials', () => {
  const valid = { email: 'jose@example.com', name: 'José', password: 'longenough1' };

  it('accepts valid input', () => {
    expect(() => assertValidCredentials(valid)).not.toThrow();
  });

  it('rejects a short password with PASSWORD_TOO_SHORT', () => {
    expect(() => assertValidCredentials({ ...valid, password: 'short' })).toThrowError(
      expect.objectContaining({ code: 'PASSWORD_TOO_SHORT' }),
    );
  });

  it('rejects a blank name with NAME_REQUIRED', () => {
    expect(() => assertValidCredentials({ ...valid, name: '   ' })).toThrowError(expect.objectContaining({ code: 'NAME_REQUIRED' }));
  });

  it('rejects an invalid email with INVALID_EMAIL', () => {
    expect(() => assertValidCredentials({ ...valid, email: 'nope' })).toThrowError(expect.objectContaining({ code: 'INVALID_EMAIL' }));
  });
});

describe('createUser', () => {
  it('stores a normalized email, a hashed password (never the raw one), and defaults to the customer role', async () => {
    const { db, collection } = makeMockDb();
    const user = await createUser(db, { email: ' Buyer@Example.com ', name: ' Buyer ', password: 'longenough1' });

    const inserted = collection.insertOne.mock.calls[0][0];
    expect(inserted.email).toBe('buyer@example.com');
    expect(inserted.name).toBe('Buyer');
    expect(inserted.role).toBe('customer');
    expect(inserted.disabled).toBe(false);
    expect(inserted.passwordHash).not.toContain('longenough1');
    expect(inserted.passwordHash.startsWith('scrypt:')).toBe(true);
    expect(user.email).toBe('buyer@example.com');
  });

  it('honours an explicit admin role', async () => {
    const { db, collection } = makeMockDb();
    await createUser(db, { email: 'admin@example.com', name: 'Admin', password: 'longenough1', role: 'admin' });
    expect(collection.insertOne.mock.calls[0][0].role).toBe('admin');
  });

  it('translates a duplicate-key error from the unique index into EMAIL_TAKEN', async () => {
    const { db } = makeMockDb({ insertOneError: Object.assign(new Error('E11000 duplicate key'), { code: 11000 }) });
    await expect(createUser(db, { email: 'taken@example.com', name: 'Taken', password: 'longenough1' })).rejects.toThrowError(
      expect.objectContaining({ code: 'EMAIL_TAKEN' }),
    );
  });

  it('rejects invalid input before touching the database', async () => {
    const { db, collection } = makeMockDb();
    await expect(createUser(db, { email: 'bad', name: 'X', password: 'longenough1' })).rejects.toBeInstanceOf(UserError);
    expect(collection.insertOne).not.toHaveBeenCalled();
  });
});

describe('authenticateUser', () => {
  it('returns the user for a correct password', async () => {
    const user = makeUser();
    const { db } = makeMockDb({ findOneResult: user });
    await expect(authenticateUser(db, 'buyer@example.com', 'correct-horse-battery')).resolves.toBe(user);
  });

  it('returns null for a wrong password', async () => {
    const { db } = makeMockDb({ findOneResult: makeUser() });
    await expect(authenticateUser(db, 'buyer@example.com', 'wrong')).resolves.toBeNull();
  });

  it('returns null for an unknown address', async () => {
    const { db } = makeMockDb({ findOneResult: null });
    await expect(authenticateUser(db, 'nobody@example.com', 'correct-horse-battery')).resolves.toBeNull();
  });

  it('refuses a disabled account even with the correct password', async () => {
    const { db } = makeMockDb({ findOneResult: makeUser({ disabled: true }) });
    await expect(authenticateUser(db, 'buyer@example.com', 'correct-horse-battery')).resolves.toBeNull();
  });

  it('looks the account up by its normalized address', async () => {
    const { db, collection } = makeMockDb({ findOneResult: makeUser() });
    await authenticateUser(db, ' Buyer@EXAMPLE.com ', 'correct-horse-battery');
    expect(collection.findOne).toHaveBeenCalledWith({ email: 'buyer@example.com' });
  });
});

describe('updateProfile', () => {
  it('normalizes the new email and trims the name', async () => {
    const updated = makeUser({ email: 'new@example.com', name: 'New Name' });
    const { db, collection } = makeMockDb({ findOneAndUpdateResult: updated });

    await updateProfile(db, updated._id, { name: '  New Name  ', email: '  New@Example.com  ' });

    const patch = collection.findOneAndUpdate.mock.calls[0][1].$set;
    expect(patch.email).toBe('new@example.com');
    expect(patch.name).toBe('New Name');
  });

  it('surfaces a collision with another account as EMAIL_TAKEN', async () => {
    const { db } = makeMockDb({ findOneAndUpdateError: Object.assign(new Error('E11000'), { code: 11000 }) });
    await expect(updateProfile(db, new ObjectId(), { name: 'X', email: 'taken@example.com' })).rejects.toThrowError(
      expect.objectContaining({ code: 'EMAIL_TAKEN' }),
    );
  });

  it('reports a missing account rather than silently succeeding', async () => {
    const { db } = makeMockDb({ findOneAndUpdateResult: null });
    await expect(updateProfile(db, new ObjectId(), { name: 'X', email: 'x@example.com' })).rejects.toThrowError(
      expect.objectContaining({ code: 'USER_NOT_FOUND' }),
    );
  });
});

describe('toSessionUser / isAdmin', () => {
  it('carries only id, email, name and role into the session — never the password hash', () => {
    const user = makeUser();
    const sessionUser = toSessionUser(user);
    expect(Object.keys(sessionUser).sort()).toEqual(['email', 'id', 'name', 'role']);
    expect(JSON.stringify(sessionUser)).not.toContain(user.passwordHash);
  });

  it('treats only the admin role as admin', () => {
    expect(isAdmin(toSessionUser(makeUser({ role: 'admin' })))).toBe(true);
    expect(isAdmin(toSessionUser(makeUser({ role: 'customer' })))).toBe(false);
    expect(isAdmin(undefined)).toBe(false);
  });
});
