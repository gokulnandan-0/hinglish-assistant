FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY eval ./eval
COPY test ./test
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY config ./config
COPY src/db/migrations ./src/db/migrations
USER node
EXPOSE 8080
CMD ["node", "dist/src/index.js"]
