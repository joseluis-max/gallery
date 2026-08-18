// pnpm verify-storage
//
// Proves the configured storage backend actually works AND that the paywall boundary
// holds, before a real shoot is uploaded to it. Runs against whatever STORAGE_DRIVER
// points at, writes two throwaway probe objects, and deletes them again.
//
// The check that matters is the last one: an original must NOT be readable without a
// signature. With a single bucket that property comes from one conditional IAM binding,
// so it is worth re-running this after any change to the bucket's policy — a mis-scoped
// condition is invisible until someone finds the URL.
import { randomUUID } from 'node:crypto';
import { getGcsConfig, getStorageAdapter, getStorageDriver, getLocalStorageDir } from './config.ts';
import { GCS_ENDPOINT } from '../src/lib/storage.ts';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** A failure that means "not safe to use", as opposed to "not wired up yet". */
  critical?: boolean;
}

const checks: Check[] = [];
function record(name: string, ok: boolean, detail: string, critical = false) {
  checks.push({ name, ok, detail, critical });
  console.log(`  ${ok ? 'PASS' : critical ? 'FAIL' : 'warn'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function status(url: string): Promise<number> {
  try {
    const response = await fetch(url, { method: 'GET' });
    return response.status;
  } catch (err) {
    return err instanceof Error && err.message.includes('fetch failed') ? 0 : -1;
  }
}

async function main() {
  const driver = getStorageDriver();
  const storage = getStorageAdapter();
  const probe = `__verify/${randomUUID()}.txt`;
  const originalBody = Buffer.from(`original ${probe}`);
  const publicBody = Buffer.from(`derivative ${probe}`);

  console.log(`Storage driver: ${driver}`);
  if (driver === 'local') {
    console.log(`Local directory: ${getLocalStorageDir()}`);
  } else {
    const cfg = getGcsConfig();
    console.log(`Bucket: ${cfg.bucket}  (originals: ${cfg.originalsPrefix}/, public: ${cfg.publicPrefix}/)`);
  }
  console.log('');

  try {
    await storage.putObject({ bucket: 'originals', key: probe, body: originalBody, contentType: 'text/plain' });
    await storage.putObject({ bucket: 'public', key: probe, body: publicBody, contentType: 'text/plain' });
    record('write to both prefixes', true, '');
  } catch (err) {
    record('write to both prefixes', false, err instanceof Error ? err.message : String(err), true);
    return finish();
  }

  try {
    const readBack = await storage.getObject({ bucket: 'originals', key: probe });
    record('read an original back', readBack.equals(originalBody), 'bytes match what was written', true);
  } catch (err) {
    record('read an original back', false, err instanceof Error ? err.message : String(err), true);
  }

  const publicUrl = storage.publicUrl(probe);
  record('publicUrl targets the public prefix', publicUrl.includes(`/${probe}`) && !publicUrl.includes('originals'), publicUrl, true);

  if (driver === 'gcs') {
    const cfg = getGcsConfig();

    const publicStatus = await status(publicUrl);
    record(
      'derivative is publicly readable',
      publicStatus === 200,
      `GET ${publicUrl} -> ${publicStatus}${publicStatus === 403 ? ' (the public IAM binding is missing or its prefix condition does not match)' : ''}`,
      true,
    );

    // The whole point of the exercise: the same object, addressed directly, with no
    // signature. Anything but 403/404 means originals are downloadable by anyone who
    // can guess a key.
    const nakedOriginalUrl = `${GCS_ENDPOINT}/${cfg.bucket}/${cfg.originalsPrefix}/${probe}`;
    const originalStatus = await status(nakedOriginalUrl);
    record(
      'ORIGINAL is NOT publicly readable',
      originalStatus === 403 || originalStatus === 404,
      `GET ${nakedOriginalUrl} -> ${originalStatus}${originalStatus === 200 ? '  *** originals are exposed — fix the bucket IAM condition before uploading anything ***' : ''}`,
      true,
    );

    const signed = await storage.getPresignedGetUrl({ bucket: 'originals', key: probe, expiresInSeconds: 120 });
    const signedStatus = await status(signed);
    record('presigned URL delivers the original', signedStatus === 200, `signed GET -> ${signedStatus}`, true);
  } else {
    record('public/private HTTP checks', true, 'skipped: only meaningful for a cloud driver');
  }

  try {
    await storage.deleteObject({ bucket: 'originals', key: probe });
    await storage.deleteObject({ bucket: 'public', key: probe });
    record('delete both probe objects', true, '');
  } catch (err) {
    record('delete both probe objects', false, `${err instanceof Error ? err.message : String(err)} — remove ${probe} by hand`);
  }

  finish();
}

function finish(): never {
  const failures = checks.filter((c) => !c.ok && c.critical);
  console.log('');
  if (failures.length === 0) {
    console.log('All checks passed.');
    process.exit(0);
  }
  console.log(`${failures.length} critical check(s) failed:`);
  for (const failure of failures) console.log(`  - ${failure.name}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
