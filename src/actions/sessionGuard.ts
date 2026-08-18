import { ActionError } from 'astro:actions';
import type { ActionAPIContext } from 'astro:actions';
import { getDbConfig } from '../lib/config';
import { getDb } from '../lib/db';
import { findActiveUserById, type UserDoc } from '../lib/users';

/**
 * The signed-in-customer counterpart to `requireAdmin` in ./adminGuard.ts.
 *
 * Revalidates the cookie's user against the database rather than trusting the session
 * snapshot: an account disabled mid-session loses access immediately instead of at cookie
 * expiry. That matters most for the free-download claims, where the session's copy of a
 * user is a point-in-time snapshot and the credit balance is not on it — the balance is
 * always read from the document this returns.
 */
export async function requireSessionUser(context: ActionAPIContext): Promise<UserDoc> {
  const sessionUser = await context.session?.get('user');
  if (!sessionUser) throw new ActionError({ code: 'UNAUTHORIZED', message: 'AUTH_REQUIRED' });

  const db = await getDb(getDbConfig());
  const current = await findActiveUserById(db, sessionUser.id);
  if (!current) {
    context.session?.delete('user');
    throw new ActionError({ code: 'UNAUTHORIZED', message: 'AUTH_REQUIRED' });
  }
  return current;
}
