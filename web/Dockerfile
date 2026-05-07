FROM oven/bun:1.3.9-alpine AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM dependencies AS build
COPY . .
RUN bun run build

FROM node:22-alpine AS production
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/build ./build
EXPOSE 5173
CMD ["node", "./node_modules/.bin/react-router-serve", "./build/server/index.js"]
