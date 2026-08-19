# Astro SSR (@astrojs/node standalone) on Cloud Run.
#
# Debian slim, not Alpine: sharp ships prebuilt glibc binaries, and on musl it either
# falls back to a much slower build or needs libvips compiled at install time. The image
# is bigger; the image pipeline is the whole product.
FROM node:22-slim AS build

WORKDIR /app
# Not `corepack enable`: the corepack bundled with these node images carries outdated signing
# keys and dies resolving current pnpm with "Cannot find matching keyid". Installing a
# pinned pnpm is both a fix and more deterministic than "whatever is latest today".
# pnpm 11 requires Node >= 22.13, which is why the base image is the 22 LTS line rather
# than the 22.12 floor in package.json engines.
RUN npm install -g pnpm@11.1.1

# Dependencies first, as their own layer — application edits shouldn't re-resolve the
# lockfile or recompile sharp's bindings.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

# PUBLIC_SITE_URL is a *client* astro:env var: it is inlined into the built output
# (canonical URLs, hreflang, sitemap, OG tags), so it has to be known at build time
# rather than injected as a runtime environment variable. cloudbuild.yaml supplies it as
# `--build-arg PUBLIC_SITE_URL=${_SITE_URL}`.
#
# Any build path that does NOT pass it fails here rather than shipping a wrong canonical
# URL, and it fails as "PUBLIC_SITE_URL is missing" rather than "empty": an unset ARG makes
# the ENV below the empty string, and astro:env treats "" as absent. That is what the Cloud
# Run console's continuous-deployment wizard does -- it generates its own inline build
# config with no --build-arg -- so the trigger must be pointed at cloudbuild.yaml. See the
# deploy section of the README.
ARG PUBLIC_SITE_URL
ENV PUBLIC_SITE_URL=$PUBLIC_SITE_URL

# The build imports astro:env's schema, which validates required *secrets* at startup
# rather than at build time — but MONGODB_URI is read by the config module, so give the
# build a syntactically valid placeholder. Nothing connects during a build.
ENV MONGODB_URI=mongodb://placeholder-not-used-at-build-time:27017
# No PAYPHONE_STORE_ID here, deliberately. It used to be declared `access: 'public'` and
# given a placeholder at this line — but public values are INLINED into the built output,
# so the placeholder was what every production request actually sent to Payphone, and
# cloudbuild.yaml's --set-env-vars was inert against a literal already compiled into the
# bundle. It is `access: 'secret'` now (astro.config.mjs), which is resolved at runtime and
# therefore must NOT be defined here: a build-stage value would be the thing that hides the
# same class of bug next time.
RUN pnpm run build

# Ship only what the server needs: no source, no dev dependencies, no build toolchain.
RUN pnpm prune --prod

FROM node:22-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
# Cloud Run injects PORT and expects the process to listen on 0.0.0.0.
ENV HOST=0.0.0.0
ENV PORT=8080

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# Runs unprivileged — the node image's built-in `node` user, no root in the container.
USER node

EXPOSE 8080
CMD ["node", "dist/server/entry.mjs"]
