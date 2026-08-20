/**
 * The two pieces every email in the app needs before it can be built, in one place so the
 * order receipt and the password-reset notice can't drift apart on either one.
 *
 * Deliberately not a template engine. Mail clients strip <style> blocks and have no
 * flexbox, so the markup in each builder stays inline-styled and table-based; what is
 * shared here is the escaping and the placeholder substitution, which are the two things
 * that are actually easy to get wrong twice.
 */

/**
 * Values interpolated into email HTML are photographer-supplied titles, buyer-supplied
 * text and URLs carrying base64url tokens. A single unescaped `&` in a URL is enough to
 * break a download or reset link in an HTML client, quite apart from the injection case.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Fills `{name}` placeholders from the dictionaries. An unknown key is left as-is rather
 *  than blanked, so a missing value shows up as `{order}` in a test instead of silently
 *  becoming an empty sentence in someone's inbox. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match));
}

/** The one accent the emails use, matching --color-accent in the light theme. Mail clients
 *  have no custom properties, so this is a literal — but only one literal. */
export const EMAIL_ACCENT = '#b4401f';
