import { defineMiddleware } from 'astro:middleware';

const LOCALES = ['es', 'en'] as const;
type Locale = (typeof LOCALES)[number];

function isLocale(value: string | undefined): value is Locale {
  return !!value && (LOCALES as readonly string[]).includes(value);
}

export const onRequest = defineMiddleware(async (context, next) => {
  // The `[lang]` file-based dynamic segment matches ANY single path segment — a literal
  // request to `/fr/gallery` would otherwise render with an unsupported locale, since
  // nothing in the route pattern itself constrains it to `es`/`en`. Centralized here
  // once, rather than repeated at the top of every `[lang]/*.astro` page.
  if ('lang' in context.params && !isLocale(context.params.lang)) {
    return new Response('Not found', { status: 404 });
  }

  // The admin app's real entry-point component lives at ADMIN_HOME_ROUTE — an
  // internal-only path that nothing ever links to directly (AdminLayout, the login
  // script, and every guard below all target bare /admin instead). Bare /admin has no
  // page file of its own: this middleware always serves ADMIN_HOME_ROUTE's content for
  // it via an internal rewrite, so the URL bar stays on /admin and there's exactly one
  // entry point into the panel, with no separate login route to keep guarded.
  // `context.rewrite()` re-enters this middleware for the target path, so
  // ADMIN_HOME_ROUTE itself must fall through to `next()` below rather than being
  // special-cased, or the rewrite would loop back on itself. The route's own directory
  // name is arbitrary internal plumbing — it's never rendered as a visible URL — kept
  // as-is rather than renamed to something more on-brand, since this exact combination
  // (this path string, reached only via an internal rewrite from a page that itself
  // resolves) is what's confirmed stable across cold dev-server boots; some other
  // superficially-equivalent path/route shapes intermittently failed to register in this
  // environment for reasons that didn't reduce to any single identifiable cause.
  const pathname = context.url.pathname;
  const ADMIN_HOME_ROUTE = '/admin/freshcheck9';

  if (pathname === '/admin') {
    return context.rewrite(ADMIN_HOME_ROUTE);
  }

  // Guards every other /admin PAGE. Admin Actions (`/_actions/admin.*`) are guarded
  // separately, at the action level via `defineAdminAction` in src/actions/admin.ts — a
  // raw 401/redirect distinction doesn't apply to a JSON RPC call the way it does for a
  // page navigation, so those return a 401 ActionError instead. Both paths are equally
  // unreachable without a valid session; only the shape of the rejection differs.
  if (pathname.startsWith('/admin/') && pathname !== ADMIN_HOME_ROUTE) {
    const authed = await context.session?.get('adminAuthed');
    if (!authed) {
      return context.rewrite(ADMIN_HOME_ROUTE);
    }
  }

  return next();
});
