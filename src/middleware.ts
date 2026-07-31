import { defineMiddleware } from 'astro:middleware';
import { middleware as createI18nMiddleware } from 'astro:i18n';

const LOCALES = ['es', 'en'] as const;
type Locale = (typeof LOCALES)[number];

function isLocale(value: string | undefined): value is Locale {
  return !!value && (LOCALES as readonly string[]).includes(value);
}

// astro.config.mjs sets i18n.routing to 'manual' specifically so this can be applied
// selectively — Astro's built-in (non-manual) i18n enforcement 404s EVERY "page"-type
// route without a locale prefix project-wide, not just ones under [lang], which was
// silently 404ing the entire /admin/* panel. These options reproduce the exact
// strategy the previous `{ prefixDefaultLocale: true }` config resolved to
// (astro/dist/core/app/common.js's toRoutingStrategy: prefixDefaultLocale +
// redirectToDefaultLocale both true → "pathname-prefix-always").
const i18nMiddleware = createI18nMiddleware({
  prefixDefaultLocale: true,
  redirectToDefaultLocale: true,
  // No i18n.fallback configured (both locales are fully translated), so this is never
  // actually consulted — required by the type regardless.
  fallbackType: 'rewrite',
});

export const onRequest = defineMiddleware(async (context, next) => {
  const pathname = context.url.pathname;

  // The admin panel deliberately has no locale prefix — it's a single internal tool,
  // not bilingual public content — so it's excluded from i18n routing entirely rather
  // than running the i18n middleware against it.
  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    // The admin app's real entry-point component lives at ADMIN_HOME_ROUTE — an
    // internal-only path that nothing ever links to directly (AdminLayout, the login
    // script, and the guard below all target bare /admin instead). Bare /admin has no
    // page file of its own: this middleware always serves ADMIN_HOME_ROUTE's content
    // for it via an internal rewrite, so the URL bar stays on /admin and there's
    // exactly one entry point into the panel, with no separate login route to guard.
    const ADMIN_HOME_ROUTE = '/admin/freshcheck9';

    if (pathname === '/admin') {
      return context.rewrite(ADMIN_HOME_ROUTE);
    }

    // Guards every other /admin PAGE. Admin Actions (`/_actions/admin.*`) are guarded
    // separately, at the action level via `defineAdminAction` in src/actions/admin.ts —
    // a raw 401/redirect distinction doesn't apply to a JSON RPC call the way it does
    // for a page navigation, so those return a 401 ActionError instead. Both paths are
    // equally unreachable without a valid session; only the shape of the rejection
    // differs.
    if (pathname !== ADMIN_HOME_ROUTE) {
      const authed = await context.session?.get('adminAuthed');
      if (!authed) {
        return context.rewrite(ADMIN_HOME_ROUTE);
      }
    }

    return next();
  }

  // The `[lang]` file-based dynamic segment matches ANY single path segment — a literal
  // request to `/fr/gallery` would otherwise render with an unsupported locale, since
  // nothing in the route pattern itself constrains it to `es`/`en`. Centralized here
  // once, rather than repeated at the top of every `[lang]/*.astro` page.
  if ('lang' in context.params && !isLocale(context.params.lang)) {
    return new Response('Not found', { status: 404 });
  }

  // `i18nMiddleware`'s declared type permits returning `void` (the generic
  // MiddlewareHandler shape), which it never actually does in practice here since it
  // always either redirects/404s or delegates to `next()` — the `?? next()` is just to
  // satisfy that broader type, not a real runtime fallback.
  const result = await i18nMiddleware(context, next);
  return result ?? next();
});
