import { z } from 'astro/zod';
import { ActionError, defineAction } from 'astro:actions';
import type { ActionAPIContext } from 'astro:actions';
import {
  clearAttempts,
  isRateLimited,
  rateLimitKey,
  recordFailedAttempt,
  verifyPassword,
} from '../lib/auth';
import { writeAuditLog } from '../lib/audit';
import { getDbConfig } from '../lib/config';
import { getDb } from '../lib/db';
import { requireSessionUser } from './sessionGuard';
import {
  authenticateUser,
  createUser,
  recordLogin,
  setUserPassword,
  toSessionUser,
  updateProfile,
  UserError,
  type SessionUser,
} from '../lib/users';

/** `UserError`'s codes are already the machine-readable strings the sign-in/sign-up UI
 *  translates, so validation failures cross the Actions boundary unchanged rather than
 *  being flattened into a generic 500. */
function toActionError(err: unknown): never {
  if (err instanceof UserError) {
    throw new ActionError({ code: err.code === 'EMAIL_TAKEN' ? 'CONFLICT' : 'BAD_REQUEST', message: err.code });
  }
  throw err;
}

/** Both sign-in paths regenerate the session id before writing the user onto it — an
 *  anonymous visitor's session id (which may have been handed to them by an attacker,
 *  or simply be sitting in a shared browser) must never become an authenticated one. */
async function signIn(context: ActionAPIContext, user: SessionUser): Promise<void> {
  await context.session?.regenerate();
  context.session?.set('user', user);
}

export const auth = {
  register: defineAction({
    accept: 'json',
    input: z.object({
      name: z.string().min(1),
      email: z.string().min(1),
      password: z.string().min(1),
    }),
    handler: async (input, context) => {
      const ip = context.clientAddress ?? 'unknown';
      const key = rateLimitKey('register', ip);
      if (isRateLimited(key)) {
        throw new ActionError({ code: 'TOO_MANY_REQUESTS', message: 'TOO_MANY_ATTEMPTS' });
      }

      const db = await getDb(getDbConfig());
      try {
        // Always 'customer'. Admin accounts are created only by an existing admin
        // (actions.admin.createUser) or the create-admin CLI script — the public signup
        // form has no path to a privileged role, whatever it posts.
        const user = await createUser(db, { name: input.name, email: input.email, password: input.password, role: 'customer' });
        await signIn(context, toSessionUser(user));
        return { user: toSessionUser(user) };
      } catch (err) {
        recordFailedAttempt(key);
        toActionError(err);
      }
    },
  }),

  login: defineAction({
    accept: 'json',
    input: z.object({ email: z.string().min(1), password: z.string().min(1) }),
    handler: async (input, context) => {
      const ip = context.clientAddress ?? 'unknown';
      const key = rateLimitKey('login', ip);
      if (isRateLimited(key)) {
        throw new ActionError({ code: 'TOO_MANY_REQUESTS', message: 'TOO_MANY_ATTEMPTS' });
      }

      const db = await getDb(getDbConfig());
      const user = await authenticateUser(db, input.email, input.password);
      if (!user) {
        recordFailedAttempt(key);
        // One message for "no such account", "wrong password", and "disabled account"
        // alike — the form must not reveal which addresses have accounts.
        throw new ActionError({ code: 'UNAUTHORIZED', message: 'INVALID_CREDENTIALS' });
      }

      clearAttempts(key);
      const sessionUser = toSessionUser(user);
      await signIn(context, sessionUser);
      await recordLogin(db, user._id);

      if (user.role === 'admin') {
        await writeAuditLog(db, {
          actor: user.email,
          action: 'admin.login',
          targetType: 'user',
          targetId: user._id.toString(),
          ip,
        });
      }

      return { user: sessionUser };
    },
  }),

  logout: defineAction({
    accept: 'json',
    input: z.object({}),
    handler: async (_input, context) => {
      context.session?.delete('user');
      // Rotates the session id on the way out too, so a copy of the old cookie can't be
      // replayed against whatever this browser does next.
      await context.session?.regenerate();
      return { ok: true };
    },
  }),

  updateProfile: defineAction({
    accept: 'json',
    input: z.object({ name: z.string().min(1), email: z.string().min(1) }),
    handler: async (input, context) => {
      const user = await requireSessionUser(context);
      const db = await getDb(getDbConfig());

      try {
        const updated = await updateProfile(db, user._id, input);
        const next = toSessionUser(updated);
        context.session?.set('user', next);
        return { user: next };
      } catch (err) {
        toActionError(err);
      }
    },
  }),

  changePassword: defineAction({
    accept: 'json',
    input: z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(1) }),
    handler: async (input, context) => {
      const user = await requireSessionUser(context);
      const db = await getDb(getDbConfig());

      if (!verifyPassword(input.currentPassword, user.passwordHash)) {
        throw new ActionError({ code: 'UNAUTHORIZED', message: 'INVALID_CREDENTIALS' });
      }

      try {
        await setUserPassword(db, user._id, input.newPassword);
      } catch (err) {
        toActionError(err);
      }
      return { ok: true };
    },
  }),
};
