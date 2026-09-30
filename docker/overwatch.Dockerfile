FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY apps/overwatch/package.json apps/overwatch/
RUN npm install --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/core packages/core
COPY apps/overwatch apps/overwatch
RUN npm run build -w @proxvm/shared -w @proxvm/core -w @proxvm/overwatch

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps ./apps
COPY --from=build /app/tsconfig.base.json ./
EXPOSE 4001
CMD ["node", "apps/overwatch/dist/index.js"]
