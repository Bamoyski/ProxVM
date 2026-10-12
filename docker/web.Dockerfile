FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN npm install --no-audit --no-fund
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build -w @proxvm/shared && cd apps/web && npx vite build

FROM nginx:alpine
# HSTS stays off by default; the nginx entrypoint substitutes this line at
# container start. Enable by setting PROXVM_HSTS_HEADER to a full add_header
# line (see docker/nginx.conf.template). Plain-HTTP installs are unaffected.
ENV PROXVM_HSTS_HEADER="# HSTS disabled (set PROXVM_HSTS_HEADER to enable)"
COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80