# The app has no runtime npm dependencies, so the build stage needs no `npm ci`.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
ARG GIT_SHA=local
RUN GITHUB_SHA=$GIT_SHA node scripts/build.js

FROM node:22-alpine
# npm, npx, corepack and yarn aren't needed at runtime; removing them shrinks the image and
# drops their bundled dependencies from the Trivy scan.
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build /app/dist ./
# Built-in non-root "node" user (uid 1000); files stay root-owned, so the app can't modify itself.
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://localhost:8080/healthz >/dev/null || exit 1
CMD ["node", "src/index.js"]
