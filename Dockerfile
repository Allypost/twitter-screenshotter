FROM oven/bun:1 AS build
WORKDIR /app
RUN apt-get update && apt-get install -y curl
RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
ENV NVM_DIR=/root/.nvm
ENV NODE_VERSION=22.8.0
RUN . "$NVM_DIR/nvm.sh" \
  && nvm install "$NODE_VERSION" \
  && nvm use --delete-prefix "$NODE_VERSION" \
  && nvm alias default "$NODE_VERSION" \
  ;
ENV PATH="/root/.nvm/versions/node/v${NODE_VERSION}/bin:${PATH}"
ENV NODE_ENV=production
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build --external electron

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
# Install PM2 (process manager)
RUN npm i -g pm2
RUN npx playwright install-deps \
  && npx playwright install firefox \
  ;
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun
COPY --from=build /app/dist/server ./
# Install dependencies for playwright
RUN npx playwright install-deps \
  && npx playwright install --force firefox \
  && npm i playwright-core \
  ;
# Install browsers for playwright
CMD ["./server"]
