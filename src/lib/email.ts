/**
 * Email delivery.
 *
 * Shaped like lib/storage.ts and lib/db.ts, deliberately: a driver interface plus
 * providers that take their configuration as a *parameter*. Nothing in this file reads the
 * environment, so it is testable without an Astro runtime, and src/lib/config.ts stays the
 * one place that turns environment variables into a configured object — `createEmailer()`
 * there is the app's single entry point, exactly as `createStorage()` is for bytes.
 *
 * This replaces a console-only stub. That stub was not a neutral default: `sendEmail`
 * resolved to `console.log` and no caller ever swapped it, so every order confirmation
 * since the store opened was written to the container's stdout and nothing was ever
 * delivered. Hence `EMAIL_DRIVER` defaults to `mailgun` rather than `console` — a
 * deployment that forgets to configure email now fails loudly instead of silently
 * swallowing the only deliverable a digital-download store has.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** Optional HTML alternative. The plain-text part is always sent alongside it, so a
   *  client that refuses HTML still gets a readable receipt with usable links. */
  html?: string;
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<void>;
}

export type EmailDriver = 'console' | 'mailgun';

/** Development and test fallback. Never selected unless `EMAIL_DRIVER=console` is set
 *  explicitly — see the file header for why that is not the default. */
export class ConsoleEmailProvider implements EmailProvider {
  async send(message: EmailMessage): Promise<void> {
    console.log(`[email:console] to=${message.to} subject="${message.subject}"\n${message.text}`);
  }
}

export interface MailgunConfig {
  apiKey: string;
  /** The sending domain as registered in Mailgun, e.g. `mg.valdiviezo.photo`. */
  domain: string;
  /** RFC 5322 From header, e.g. `José Valdiviezo <no-reply@mg.valdiviezo.photo>`. The
   *  address must belong to `domain` or Mailgun refuses the message. */
  from: string;
  /** API host: `https://api.mailgun.net` for a US domain, `https://api.eu.mailgun.net`
   *  for an EU one. Configurable rather than hard-coded because an EU-provisioned domain
   *  returns 401 on the US host even with a perfectly valid key — the single most common
   *  cause of "the key is right and nothing sends". */
  baseUrl: string;
  /** A hung request here blocks the buyer's redirect off the payment return leg, so the
   *  send is bounded rather than left to the platform default. */
  timeoutMs: number;
}

export class MailgunEmailProvider implements EmailProvider {
  constructor(private readonly config: MailgunConfig) {}

  async send(message: EmailMessage): Promise<void> {
    const form = new URLSearchParams({
      from: this.config.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
    if (message.html) form.set('html', message.html);

    const endpoint = `${this.config.baseUrl.replace(/\/$/, '')}/v3/${encodeURIComponent(this.config.domain)}/messages`;

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          // Mailgun authenticates with HTTP basic auth whose username is the literal
          // string "api" and whose password is the private API key.
          Authorization: `Basic ${Buffer.from(`api:${this.config.apiKey}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form,
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (err) {
      throw new Error(`Mailgun request to ${endpoint} failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!response.ok) {
      // Mailgun explains itself in the body — "Domain not found", "Forbidden" for a key
      // from the wrong region, "not a valid address" for an unauthorized recipient on a
      // sandbox domain. Losing that text is what makes this failure hard to diagnose, so
      // it is carried into the thrown error rather than reduced to a status code.
      const detail = await response.text().catch(() => '');
      throw new Error(`Mailgun rejected the message (HTTP ${response.status}): ${detail.slice(0, 500)}`);
    }
  }
}

export type EmailConfig = { driver: 'console' } | ({ driver: 'mailgun' } & MailgunConfig);

export function createEmailProvider(config: EmailConfig): EmailProvider {
  if (config.driver === 'console') return new ConsoleEmailProvider();
  return new MailgunEmailProvider(config);
}
