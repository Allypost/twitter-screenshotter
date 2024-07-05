FROM node:22-bookworm-slim
WORKDIR /app
RUN corepack enable pnpm && corepack install --global pnpm
RUN npx playwright install-deps
# Install PM2 (process manager)
RUN npm i -g pm2
COPY pnpm-lock.yaml package.json ./
ENV NODE_ENV=production
RUN pnpm install --frozen-lockfile
COPY . .
# Install dependencies for playwright
RUN npx playwright install-deps
CMD ["pm2", "start", "--name", "Twitter Screenshotter", "--no-daemon", "-i", "max", "index.js"]
