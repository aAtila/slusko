FROM oven/bun:1.3.9-alpine AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM dependencies AS build
COPY . .
RUN bun run build

FROM oven/bun:1.3.9-alpine AS production
ENV NODE_ENV=production
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY --from=build /app/build ./build
EXPOSE 5173
CMD ["bun", "run", "start"]
