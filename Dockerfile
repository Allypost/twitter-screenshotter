FROM ubuntu:20.04

RUN mkdir -p /app

WORKDIR /app

RUN apt-get update && apt-get install -y \
  bash \
  gcc \
  g++ \
  make \
  curl

# Install NodeJS
RUN curl -fsSL https://deb.nodesource.com/setup_16.x | bash -
RUN apt-get install -y nodejs

# Install yarn
RUN curl -sL https://dl.yarnpkg.com/debian/pubkey.gpg | gpg --dearmor | tee /usr/share/keyrings/yarnkey.gpg >/dev/null && echo "deb [signed-by=/usr/share/keyrings/yarnkey.gpg] https://dl.yarnpkg.com/debian stable main" | tee /etc/apt/sources.list.d/yarn.list && apt-get update && apt-get install yarn

# Install dependencies for playwright
RUN npx playwright install-deps

# Install PM2 (process manager)
RUN npm i -g pm2

COPY yarn.lock package.json ./

RUN yarn install --frozen-lockfile

COPY . .

# Install dependencies for playwright
RUN npx playwright install-deps

CMD ["pm2", "start", "--name", "Twitter Screenshotter", "--no-daemon", "-i", "max", "index.js"]
