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
import { buildPasswordResetEmail } from '../lib/authEmail';
import { createEmailer, getDbConfig, getPublicSiteUrl } from '../lib/config';
import { getDb } from '../lib/db';
import {
  consumePasswordResetToken,
  invalidatePasswordResetTokens,
  mintPasswordResetToken,
  RESET_TOKEN_TTL_MINUTES,
} from '../lib/passwordReset';
import { requireSessionUser } from './sessionGuard';
import {
  assertValidPassword,
  authenticateUser,
  createUser,
  findUserByEmail,
  findUserById,
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

      // Any reset link still in flight is now stale. Someone who changes their password
      // because they suspect their inbox was seen must not leave a working way back in
      // sitting in that inbox.
      await invalidatePasswordResetTokens(db, user._id);
      return { ok: true };
    },
  }),

  /**
   * Step one of forgotten-password recovery: mail a single-use link.
   *
   * **This action tells the caller nothing.** It returns `{ ok: true }` for a registered
   * address, an unregistered one, a disabled account, and a failed send alike. That is the
   * whole design: a "no such account" response here would turn the form into a way to test
   * whether any given address shops with this photographer, which is precisely what the
   * sign-in action already refuses to leak. The cost is that a broken mailer looks like
   * success to the visitor — so a send failure is logged loudly, because the server log is
   * the only place it can be reported without also answering the enumeration question.
   */
  requestPasswordReset: defineAction({
    accept: 'json',
    input: z.object({ email: z.string().min(1), lang: z.enum(['es', 'en']) }),
    handler: async (input, context) => {
      const ip = context.clientAddress ?? 'unknown';
      const key = rateLimitKey('password-reset', ip);
      // Rate limited on *every* request rather than only on failures, unlike sign-in:
      // there is no such thing as a failed attempt here to count, and what needs bounding
      // is how many emails one caller can cause to be sent.
      if (isRateLimited(key)) {
        throw new ActionError({ code: 'TOO_MANY_REQUESTS', message: 'TOO_MANY_ATTEMPTS' });
      }
      recordFailedAttempt(key);

      const db = await getDb(getDbConfig());
      const user = await findUserByEmail(db, input.email);

      // A disabled account gets no link either: reactivating is the photographer's call,
      // and a reset would otherwise be a way around the disable switch.
      if (user && !user.disabled) {
        try {
          const raw = await mintPasswordResetToken(db, { userId: user._id, email: user.email, ip });
          const message = buildPasswordResetEmail({
            lang: input.lang,
            // The token rides in the query string. Browsers default to
            // `strict-origin-when-cross-origin`, so the cross-origin request for the
            // photograph on the reset page sends only the origin — never this URL — and
            // keeping it addressable means a reload does not break the page mid-reset.
            resetUrl: `${getPublicSiteUrl()}/${input.lang}/account/reset?token=${encodeURIComponent(raw)}`,
            ttlMinutes: RESET_TOKEN_TTL_MINUTES,
          });
          await createEmailer().send({ to: user.email, ...message });
        } catch (err) {
          console.error('auth.requestPasswordReset: could not send the reset link to', user.email, err);
        }
      }

      return { ok: true };
    },
  }),

  /**
   * Step two: spend the link and set the new password.
   *
   * Order matters here. The password is validated *before* the token is consumed, so
   * someone who types four characters gets "too short" and keeps a working link, rather
   * than burning their one use on a typo and having to start over.
   */
  resetPassword: defineAction({
    accept: 'json',
    input: z.object({ token: z.string().min(1), password: z.string().min(1) }),
    handler: async (input, context) => {
      const ip = context.clientAddress ?? 'unknown';
      const key = rateLimitKey('password-reset-confirm', ip);
      if (isRateLimited(key)) {
        throw new ActionError({ code: 'TOO_MANY_REQUESTS', message: 'TOO_MANY_ATTEMPTS' });
      }

      try {
        assertValidPassword(input.password);
      } catch (err) {
        toActionError(err);
      }

      const db = await getDb(getDbConfig());
      const result = await consumePasswordResetToken(db, input.token);
      if (!result.ok) {
        recordFailedAttempt(key);
        // Expired, already used, and never existed are one message to the reader: the
        // instruction is "ask for a new link" in all three cases, and distinguishing them
        // would say whether a guessed token was ever real.
        throw new ActionError({ code: 'BAD_REQUEST', message: 'RESET_TOKEN_INVALID' });
      }

      try {
        await setUserPassword(db, result.userId, input.password);
      } catch (err) {
        toActionError(err);
      }

      // Every other link for this account dies with the one just used, so a second reset
      // email sitting in the inbox is not a second chance for whoever else can read it.
      await invalidatePasswordResetTokens(db, result.userId);

      const user = await findUserById(db, result.userId);
      if (user?.role === 'admin') {
        await writeAuditLog(db, {
          actor: user.email,
          action: 'admin.passwordReset',
          targetType: 'user',
          targetId: user._id.toString(),
          ip,
        });
      }

      // Deliberately not signed in. The reset proves control of the mailbox, not of the
      // password — so the last step is typing the new one into the sign-in form, and an
      // intercepted link alone never lands anybody inside the account.
      return { ok: true };
    },
  }),
};
