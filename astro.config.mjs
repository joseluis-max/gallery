// @ts-check
import { defineConfig, envField } from 'astro/config';
import node from '@astrojs/node';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  output: 'server',
  site: process.env.PUBLIC_SITE_URL || 'http://localhost:4321',
  adapter: node({ mode: 'standalone' }),
  i18n: {
    locales: ['es', 'en'],
    defaultLocale: 'es',
    routing: { prefixDefaultLocale: true },
  },
  vite: {
    plugins: [tailwindcss()],
  },
  env: {
    schema: {
      // Public — safe to ship to the client
      PUBLIC_SITE_URL: envField.string({ context: 'client', access: 'public' }),

      // Server-only, but not secret — never needs to reach the client bundle
      R2_PUBLIC_BASE_URL: envField.string({ context: 'server', access: 'public' }),

      // Server secrets — never resolvable from client code
      MONGODB_URI: envField.string({ context: 'server', access: 'secret' }),
      MONGODB_DB_NAME: envField.string({ context: 'server', access: 'secret', default: 'valdiviezo' }),

      R2_ACCOUNT_ID: envField.string({ context: 'server', access: 'secret' }),
      R2_ACCESS_KEY_ID: envField.string({ context: 'server', access: 'secret' }),
      R2_SECRET_ACCESS_KEY: envField.string({ context: 'server', access: 'secret' }),
      R2_BUCKET_ORIGINALS: envField.string({ context: 'server', access: 'secret', default: 'originals' }),
      R2_BUCKET_PUBLIC: envField.string({ context: 'server', access: 'secret', default: 'public' }),

      STRIPE_SECRET_KEY: envField.string({ context: 'server', access: 'secret' }),
      STRIPE_WEBHOOK_SECRET: envField.string({ context: 'server', access: 'secret' }),

      ADMIN_PASSWORD_HASH: envField.string({ context: 'server', access: 'secret' }),

      DOWNLOAD_TOKEN_TTL_DAYS: envField.number({ context: 'server', access: 'public', default: 7 }),
      DOWNLOAD_TOKEN_MAX_USES: envField.number({ context: 'server', access: 'public', default: 5 }),
    },
  },
});
