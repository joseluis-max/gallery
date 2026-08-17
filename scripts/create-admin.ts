// Creates (or promotes) an admin account — the bootstrap path into /admin, and the way
// back in if every admin account gets locked out.
//
//   pnpm create-admin <email> <password> [name]
//
// Idempotent: run it against an existing account and it promotes that account to admin,
// re-enables it, and sets the given password.
import { getDb } from '../src/lib/db.ts';
import { getDbConfig } from './config.ts';
import {
  createUser,
  findUserByEmail,
  setUserDisabled,
  setUserPassword,
  setUserRole,
  UserError,
} from '../src/lib/users.ts';

async function main() {
  const [email, password, ...nameParts] = process.argv.slice(2);
  if (!email || !password) {
    console.error('Usage: pnpm create-admin <email> <password> [name]');
    process.exit(1);
  }

  const db = await getDb(getDbConfig());
  const existing = await findUserByEmail(db, email);

  if (existing) {
    await setUserPassword(db, existing._id, password);
    await setUserRole(db, existing._id, 'admin');
    if (existing.disabled) await setUserDisabled(db, existing._id, false);
    console.log(`Updated existing account ${existing.email} — now an enabled admin with the given password.`);
    process.exit(0);
  }

  const user = await createUser(db, {
    email,
    password,
    name: nameParts.join(' ') || email.split('@')[0],
    role: 'admin',
  });
  console.log(`Created admin ${user.email} (${user._id.toString()}). Sign in at /admin.`);
  process.exit(0);
}

main().catch((err) => {
  if (err instanceof UserError) {
    // The validation codes are terse on purpose (they cross the Actions boundary to the
    // UI); spell them out for someone reading a terminal.
    const explanations: Record<string, string> = {
      INVALID_EMAIL: 'That email address is not valid.',
      PASSWORD_TOO_SHORT: 'The password must be at least 8 characters.',
      NAME_REQUIRED: 'A name is required.',
      EMAIL_TAKEN: 'An account with that email already exists.',
      USER_NOT_FOUND: 'That account no longer exists.',
    };
    console.error(explanations[err.code] ?? err.code);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
