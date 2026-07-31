// pnpm hash-admin-password <password>
// Prints a scrypt hash suitable for the ADMIN_PASSWORD_HASH env var. Run this locally —
// never commit the output, never log it anywhere else.
import { hashPassword } from '../src/lib/auth.ts';

const password = process.argv[2];
if (!password) {
  console.error('Usage: pnpm hash-admin-password <password>');
  process.exit(1);
}

console.log(hashPassword(password));
