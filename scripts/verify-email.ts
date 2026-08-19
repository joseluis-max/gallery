// pnpm verify-email <recipient@example.com>
//
// Proves the configured email provider actually delivers, without having to make a
// purchase to find out. It exists because the failure it checks for is silent: the store's
// whole deliverable is a download link in an email, and an email that is never sent looks
// identical, from the order page, to one that is.
//
// It sends a real message through the real provider — the same `createEmailProvider` the
// app uses, assembled from the same variables — so a pass here means a receipt would
// arrive too. Run it after any change to the Mailgun account, key, or sending domain.
import { getEmailDriver, getEmailer, getMailgunSummary } from './config.ts';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main() {
  const to = process.argv[2]?.trim();
  if (!to || !to.includes('@')) {
    fail('Usage: pnpm verify-email <recipient@example.com>');
  }

  const driver = getEmailDriver();
  console.log(`Email driver: ${driver}`);

  if (driver === 'console') {
    console.log('');
    console.log('EMAIL_DRIVER=console prints messages instead of sending them, so this run');
    console.log('proves nothing about delivery. Set EMAIL_DRIVER=mailgun to test for real.');
  } else {
    const mailgun = getMailgunSummary();
    console.log(`Domain:       ${mailgun.domain}`);
    console.log(`From:         ${mailgun.from || `(default) no-reply@${mailgun.domain}`}`);
    console.log(`API base:     ${mailgun.baseUrl}`);
    console.log(`API key:      ${mailgun.hasKey ? 'set' : 'MISSING'}`);
  }
  console.log(`To:           ${to}`);
  console.log('');

  const sentAt = new Date().toISOString();
  try {
    await getEmailer().send({
      to,
      subject: `Prueba de envío — José Valdiviezo (${sentAt})`,
      text: [
        'This is a test message from `pnpm verify-email`.',
        '',
        'If you are reading it, order confirmations and their download links will reach',
        'this address too.',
        '',
        `Sent at ${sentAt}.`,
      ].join('\n'),
      html: `<p>This is a test message from <code>pnpm verify-email</code>.</p>
<p>If you are reading it, order confirmations and their download links will reach this address too.</p>
<p style="color:#6f6862;font-size:12px;">Sent at ${sentAt}.</p>`,
    });
  } catch (err) {
    console.error(`FAIL  ${err instanceof Error ? err.message : String(err)}`);
    console.error('');
    // The four failures worth naming, because each one produces a message that reads like
    // one of the others and sends people to the wrong place.
    console.error('Most likely causes, in the order worth checking:');
    console.error('  401/Forbidden  — wrong key, or an EU-region domain being called on the US host.');
    console.error('                   Set MAILGUN_BASE_URL=https://api.eu.mailgun.net for an EU domain.');
    console.error('  404            — MAILGUN_DOMAIN does not match a domain on this account.');
    console.error('  "not a valid address" or a 200 that never arrives');
    console.error('                 — a sandbox domain only delivers to Authorized Recipients.');
    console.error('                   Add the address in Mailgun, or verify a real domain.');
    console.error('  Accepted but absent');
    console.error('                 — check Mailgun → Sending → Logs. DNS (SPF/DKIM) not verified');
    console.error('                   means delivered-to-spam or dropped at the receiving end.');
    process.exit(1);
  }

  if (driver === 'console') {
    console.log('');
    console.log(`PASS  The message above was printed, not sent. Nothing was delivered to ${to}.`);
    return;
  }

  console.log(`PASS  Mailgun accepted the message for ${to}.`);
  console.log('');
  console.log('Acceptance is not delivery: confirm it arrived, and check Mailgun → Sending →');
  console.log('Logs if it did not. A domain whose DNS records are unverified is accepted by');
  console.log('the API and then dropped or spam-foldered by the recipient.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
