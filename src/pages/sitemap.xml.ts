import type { APIRoute } from 'astro';
import { listPublishedCompetitions } from '../lib/competitions';
import { getDbConfig } from '../lib/config';
import { getDb } from '../lib/db';
import type { PhotoDoc } from '../lib/photos';

export const prerender = false;

const LOCALES = ['es', 'en'] as const;
const STATIC_PATHS = ['', 'competitions', 'portfolio', 'gallery', 'about'];

export const GET: APIRoute = async ({ site, url }) => {
  const base = (site ?? new URL(url.origin)).toString().replace(/\/$/, '');
  const db = await getDb(getDbConfig());
  // Published only, on both queries — a draft competition or photograph must not be
  // discoverable through the sitemap after being deliberately kept off the site.
  const [photos, competitions] = await Promise.all([
    db
      .collection<PhotoDoc>('photos')
      .find({ status: 'published' }, { projection: { slug: 1, updatedAt: 1 } })
      .toArray(),
    listPublishedCompetitions(db),
  ]);

  const urls: { loc: string; lastmod?: Date }[] = [];
  for (const locale of LOCALES) {
    for (const path of STATIC_PATHS) {
      urls.push({ loc: `${base}/${locale}/${path}`.replace(/\/$/, '/') });
    }
    for (const competition of competitions) {
      urls.push({ loc: `${base}/${locale}/competitions/${competition.slug}`, lastmod: competition.updatedAt });
    }
    // Photograph URLs stay under /gallery/<slug> regardless of competition, so moving a
    // photograph between events never changes its canonical address.
    for (const photo of photos) {
      urls.push({ loc: `${base}/${locale}/gallery/${photo.slug}`, lastmod: photo.updatedAt });
    }
  }

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (u) => `  <url>
    <loc>${u.loc}</loc>${u.lastmod ? `\n    <lastmod>${new Date(u.lastmod).toISOString()}</lastmod>` : ''}
  </url>`,
  )
  .join('\n')}
</urlset>
`;

  return new Response(body, { headers: { 'Content-Type': 'application/xml' } });
};
