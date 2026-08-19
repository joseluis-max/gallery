import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsoleEmailProvider, createEmailProvider, MailgunEmailProvider } from '../../src/lib/email';

const config = {
  apiKey: 'key-abc123',
  domain: 'mg.example.com',
  from: 'José Valdiviezo <no-reply@mg.example.com>',
  baseUrl: 'https://api.mailgun.net',
  timeoutMs: 10_000,
};

const message = {
  to: 'buyer@example.com',
  subject: 'Tu pedido #2b98db80 — José Valdiviezo',
  text: 'Descargar: https://josevaldiviezo.com/api/download/tok',
  html: '<a href="https://josevaldiviezo.com/api/download/tok">Descargar</a>',
};

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue(new Response('', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The request Mailgun actually received, decoded back out of the URLSearchParams body. */
function sentForm(): URLSearchParams {
  return new URLSearchParams(fetchMock.mock.calls[0][1].body.toString());
}

describe('MailgunEmailProvider', () => {
  it('posts a form-encoded message to the domain messages endpoint', async () => {
    await new MailgunEmailProvider(config).send(message);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.mailgun.net/v3/mg.example.com/messages');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');

    const form = sentForm();
    expect(form.get('from')).toBe(config.from);
    expect(form.get('to')).toBe('buyer@example.com');
    expect(form.get('subject')).toBe(message.subject);
    expect(form.get('text')).toBe(message.text);
    expect(form.get('html')).toBe(message.html);
  });

  // Mailgun's basic-auth username is the literal string "api", not the account email —
  // getting this wrong produces a 401 that reads exactly like a bad key.
  it('authenticates as "api" with the private key as the password', async () => {
    await new MailgunEmailProvider(config).send(message);

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Basic YXBpOmtleS1hYmMxMjM=');
  });

  it('sends only a text part when there is no html alternative', async () => {
    await new MailgunEmailProvider(config).send({ ...message, html: undefined });

    expect(sentForm().has('html')).toBe(false);
    expect(sentForm().get('text')).toBe(message.text);
  });

  // An EU-provisioned domain answers ONLY on the EU host. Since that is configuration
  // rather than code, the one thing worth proving is that the setting is honoured.
  it('honours a regional base URL', async () => {
    await new MailgunEmailProvider({ ...config, baseUrl: 'https://api.eu.mailgun.net/' }).send(message);

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.eu.mailgun.net/v3/mg.example.com/messages');
  });

  // The body is where Mailgun explains itself — "Domain not found", "Forbidden", "not a
  // valid address" for a sandbox domain's unauthorized recipient. Dropping it is what
  // turns a five-second fix into an afternoon.
  it('throws with the status and the explanation Mailgun gave', async () => {
    fetchMock.mockResolvedValue(new Response('{"message":"Domain not found: mg.example.com"}', { status: 404 }));

    await expect(new MailgunEmailProvider(config).send(message)).rejects.toThrow(
      /HTTP 404.*Domain not found: mg\.example\.com/,
    );
  });

  it('throws a named error when the request itself never completes', async () => {
    fetchMock.mockRejectedValue(new Error('The operation was aborted due to timeout'));

    await expect(new MailgunEmailProvider(config).send(message)).rejects.toThrow(
      /Mailgun request to https:\/\/api\.mailgun\.net\/v3\/mg\.example\.com\/messages failed: .*timeout/,
    );
  });
});

describe('createEmailProvider', () => {
  it('returns the console provider only when the console driver is chosen explicitly', () => {
    expect(createEmailProvider({ driver: 'console' })).toBeInstanceOf(ConsoleEmailProvider);
    expect(createEmailProvider({ driver: 'mailgun', ...config })).toBeInstanceOf(MailgunEmailProvider);
  });
});
