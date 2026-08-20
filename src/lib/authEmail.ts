import type { EmailMessage } from './email';
import { EMAIL_ACCENT, escapeHtml, fill } from './emailTemplate';
import { getDictionary, type Locale } from './i18n';

export interface PasswordResetEmailParams {
  lang: Locale;
  /** Absolute, and the only thing in the message that matters. A relative path is not
   *  clickable from an inbox — the same reason the download links are absolute. */
  resetUrl: string;
  ttlMinutes: number;
}

/**
 * The "you asked to reset your password" email.
 *
 * Two things here are security decisions rather than copy decisions:
 *
 *   - **The name of the account is never in the message.** The address it was sent to is
 *     already proof of who it is for, and someone reading over a shoulder learns nothing.
 *   - **It always says what to do if you did not ask for this.** That line is what turns
 *     an unexpected reset email from an alarm into a no-op: ignoring it leaves the current
 *     password working, because requesting a link changes nothing on its own.
 *
 * Both parts are built from the same data, same rule as the order receipt: the HTML part
 * is what makes the link clickable, and the text part is what survives a client that
 * strips HTML. For a message whose entire payload is one link, losing either loses the
 * reset.
 */
export function buildPasswordResetEmail(params: PasswordResetEmailParams): Omit<EmailMessage, 'to'> {
  const t = getDictionary(params.lang).email.passwordReset;
  const validity = fill(t.validity, { minutes: params.ttlMinutes });

  const text = [t.subject, '', t.intro, '', params.resetUrl, '', validity, '', t.ignore].join('\n');

  const html = `<div style="font-family:Georgia,serif;color:#2b2724;max-width:560px;margin:0 auto;padding:24px;">
<h1 style="font-size:20px;font-weight:normal;">${escapeHtml(t.subject)}</h1>
<p style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;">${escapeHtml(t.intro)}</p>
<p style="font-family:system-ui,sans-serif;font-size:14px;margin:24px 0;">
<a href="${escapeHtml(params.resetUrl)}" style="display:inline-block;background:${EMAIL_ACCENT};color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:999px;">${escapeHtml(t.cta)}</a></p>
${/* The bare URL under the button, because a client that renders no <a> still has to leave
      something the reader can copy — and because a visible destination is what lets a
      cautious reader check where the link goes before following it. */ ''}
<p style="font-family:system-ui,sans-serif;font-size:12px;color:#6f6862;line-height:1.5;word-break:break-all;">${escapeHtml(params.resetUrl)}</p>
<p style="font-family:system-ui,sans-serif;font-size:12px;color:#6f6862;line-height:1.5;">${escapeHtml(validity)}</p>
<p style="font-family:system-ui,sans-serif;font-size:12px;color:#6f6862;line-height:1.5;">${escapeHtml(t.ignore)}</p>
</div>`;

  return { subject: t.subject, text, html };
}
