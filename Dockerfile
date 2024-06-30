FROM ubuntu:20.04
WORKDIR /app
RUN apt-get update && apt-get install -y \
  bash \
  gcc \
  g++ \
  make \
  curl
# Install NodeJS
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
RUN apt-get install -y nodejs
RUN corepack enable pnpm && corepack install --global pnpm
# Install dependencies for playwright
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
