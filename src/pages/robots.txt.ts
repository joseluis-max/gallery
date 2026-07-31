import type { APIRoute } from 'astro';

export const prerender = false;

export const GET: APIRoute = ({ site, url }) => {
  const base = (site ?? new URL(url.origin)).toString().replace(/\/$/, '');
  const body = `User-agent: *
Disallow: /admin
Sitemap: ${base}/sitemap.xml
`;
  return new Response(body, { headers: { 'Content-Type': 'text/plain' } });
};
