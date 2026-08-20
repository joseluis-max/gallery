import { describe, expect, it } from 'vitest';
import { buildPasswordResetEmail } from '../../src/lib/authEmail.ts';

const resetUrl = 'https://valdiviezo.photo/es/account/reset?token=abc-123_XYZ';

describe('buildPasswordResetEmail', () => {
  it('puts the link in both parts — the HTML one is clickable, the text one survives a client that strips HTML', () => {
    const message = buildPasswordResetEmail({ lang: 'es', resetUrl, ttlMinutes: 60 });

    expect(message.text).toContain(resetUrl);
    expect(message.html).toContain('href="https://valdiviezo.photo/es/account/reset?token=abc-123_XYZ"');
  });

  it('escapes the URL where it is rendered as text, so a query string cannot break the markup', () => {
    const message = buildPasswordResetEmail({
      lang: 'en',
      resetUrl: 'https://valdiviezo.photo/en/account/reset?token=a&b="x"',
      ttlMinutes: 60,
    });

    expect(message.html).not.toContain('token=a&b="x"');
    expect(message.html).toContain('token=a&amp;b=&quot;x&quot;');
    // The text part is not markup and must keep the URL byte-for-byte, or the link a
    // reader copies out of it is a different link.
    expect(message.text).toContain('token=a&b="x"');
  });

  it('fills the expiry into the validity line', () => {
    const message = buildPasswordResetEmail({ lang: 'en', resetUrl, ttlMinutes: 60 });
    expect(message.text).toContain('60 minutes');
    expect(message.text).not.toContain('{minutes}');
  });

  it('writes in the requested locale', () => {
    expect(buildPasswordResetEmail({ lang: 'es', resetUrl, ttlMinutes: 60 }).subject).toBe('Restablecer tu contraseña');
    expect(buildPasswordResetEmail({ lang: 'en', resetUrl, ttlMinutes: 60 }).subject).toBe('Reset your password');
  });

  it('always says what to do if you did not ask for this — an unexpected reset email has to read as a no-op, not an alarm', () => {
    const en = buildPasswordResetEmail({ lang: 'en', resetUrl, ttlMinutes: 60 });
    const es = buildPasswordResetEmail({ lang: 'es', resetUrl, ttlMinutes: 60 });

    expect(en.text).toContain('ignore this email');
    expect(en.html).toContain('ignore this email');
    expect(es.text).toContain('ignorar este correo');
  });

  it('names nobody: the address it was sent to is already proof of who it is for', () => {
    const message = buildPasswordResetEmail({ lang: 'en', resetUrl, ttlMinutes: 60 });
    expect(message.text.toLowerCase()).not.toContain('@');
    expect(message.subject).not.toContain('@');
  });
});
