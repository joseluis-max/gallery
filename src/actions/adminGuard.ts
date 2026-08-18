import type * as zCore from 'zod/v4/core';
import { ActionError, defineAction } from 'astro:actions';
import type { ActionAPIContext } from 'astro:actions';
import { getDbConfig } from '../lib/config';
import { getDb } from '../lib/db';
import { findActiveUserById, isAdmin, toSessionUser, type SessionUser } from '../lib/users';

/**
 * The one place that answers "is this request an admin?", shared by `defineAdminAction`
 * below and by handlers that need the actor's identity for the audit log. Returns the
 * signed-in admin rather than a boolean so `writeAuditLog` can record *which* admin did
 * something instead of a generic 'admin' string.
 *
 * The cookie's `role` is treated as a hint, not as the answer: the account is re-read
 * from the database on every admin call, so revoking access takes effect on the next
 * request rather than whenever that person's session happens to expire.
 */
export async function requireAdmin(context: ActionAPIContext): Promise<SessionUser> {
  const sessionUser = await context.session?.get('user');
  if (!isAdmin(sessionUser)) {
    throw new ActionError({ code: 'UNAUTHORIZED', message: 'ADMIN_AUTH_REQUIRED' });
  }

  const db = await getDb(getDbConfig());
  const current = await findActiveUserById(db, sessionUser!.id);
  if (!current || current.role !== 'admin') {
    context.session?.delete('user');
    throw new ActionError({ code: 'UNAUTHORIZED', message: 'ADMIN_AUTH_REQUIRED' });
  }
  return toSessionUser(current);
}

/**
 * Every admin mutation (except `login`) is defined through this wrapper instead of
 * calling `defineAction` directly — that makes the auth check structural rather than
 * something each new handler has to remember to call. Skipping it requires visibly NOT
 * using this wrapper, not just forgetting a line inside a handler body.
 *
 * Generic shape deliberately mirrors `defineAction`'s own signature (same TOutput/
 * TAccept/TInputSchema constrained to `zCore.$ZodType`, the internal zod-v4-core type
 * Astro's Actions runtime is actually built against) so callers keep full input/output
 * type inference through `actions.admin.*`.
 */
export function defineAdminAction<
  TOutput,
  TAccept extends 'form' | 'json' | undefined = undefined,
  TInputSchema extends zCore.$ZodType | undefined = undefined,
>(config: {
  accept?: TAccept;
  input?: TInputSchema;
  handler: (
    input: TInputSchema extends zCore.$ZodType ? zCore.infer<TInputSchema> : unknown,
    context: ActionAPIContext,
  ) => Promise<TOutput>;
}) {
  // The cast below is necessary, not lazy: `ActionHandler<TInputSchema, TOutput>` is a
  // conditional type keyed on TInputSchema, and TypeScript cannot re-prove which branch
  // applies for a still-generic TInputSchema inside this wrapper body (a known
  // limitation of conditional type distribution over open generics). The PUBLIC
  // generic signature above is what keeps caller-side inference (`actions.admin.*`)
  // correct; this internal plumbing is fully exercised by the admin action tests.
  const guardedHandler = async (input: unknown, context: ActionAPIContext) => {
    await requireAdmin(context);
    return config.handler(input as never, context);
  };

  const defineActionConfig = {
    accept: config.accept,
    input: config.input,
    handler: guardedHandler,
  } as unknown as Parameters<typeof defineAction<TOutput, TAccept, TInputSchema>>[0];

  return defineAction(defineActionConfig);
}
