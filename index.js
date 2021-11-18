const { chromium, Browser } = require('playwright');
const fs = require('fs');
const express = require('express');
const bodyParser = require('body-parser');
const { StatusCodes } = require('http-status-codes');
const morgan = require('morgan');
const slowDown = require("express-slow-down");
const RedisStore = require("rate-limit-redis");

const HOST = process.env.HOST || 'localhost';
const PORT = process.env.PORT || 8080;

const REQUESTS_PER_SECOND = 1;
const REQUESTS_MEASURE_WINDOW_SECONDS = 1 * 60; // 1 minute

const SEND_CACHE_HEADER_FOR_SECONDS = 15 * 60 // 15 minutes

const EMBED_HTML = fs.readFileSync('./embed.html', 'utf-8');

/**
 * @type {Browser}
 */
let BROWSER;

const asyncReq =
  (handler) => async (req, res) => {
    try {
      return await handler(req, res);
    } catch {
      return res.sendStatus(StatusCodes.INTERNAL_SERVER_ERROR);
    } finally {
      try {
        await req.$page.page.close();
      } catch { }

      try {
        await req.$page.context.close();
      } catch { }
    }
  }
  ;

const app = express();

app.disable('x-powered-by');
app.enable("trust proxy");

app.use(morgan('combined'));
app.use(bodyParser.json());

const slowDownOptions = {
  windowMs: REQUESTS_MEASURE_WINDOW_SECONDS * 1000,
  delayAfter: REQUESTS_PER_SECOND * REQUESTS_MEASURE_WINDOW_SECONDS,
  delayMs: 734,
  headers: true,
};

if (process.env.REDIS_URL && String(process.env.REDIS_URL).trim().length > 0) {
  console.log('|>', process.env.REDIS_URL)
  slowDownOptions.store = new RedisStore({
    redisURL: process.env.REDIS_URL,
  });
}

const speedLimiter = slowDown(slowDownOptions);

app.get("/*", speedLimiter, asyncReq(async (req, res) => {
  const twitterUrl = req.params[0];

  if (!twitterUrl) {
    return res.sendStatus(StatusCodes.NOT_ACCEPTABLE);
  }

  const parsedUrl = new URL(twitterUrl);

  if (parsedUrl.hostname !== 'twitter.com') {
    return res.sendStatus(StatusCodes.NOT_ACCEPTABLE);
  }

  req.$page = {};

  req.$page.context = await BROWSER.newContext({
    acceptDownloads: false,
    screen: {
      width: 1920,
      height: 1080,
    },
  });
  req.$page.page = await req.$page.context.newPage();
  await req.$page.page.setContent(EMBED_HTML.replace(
    '{{URL_FOR_TWITTER}}',
    twitterUrl,
  ));

  const tweetIframe = await req.$page.page.waitForSelector('.twitter-tweet-rendered iframe');
  const frame = await tweetIframe.contentFrame();

  {
    const retweetLink = await frame.$$('a[role="link"]').then((links) => links.pop());

    retweetLink.evaluate((el) => {
      const $retweetDiv = el.parentNode;
      $retweetDiv.parentNode.removeChild($retweetDiv);
    });
  }

  {
    const copyLinkToTweetLink = await frame.$('a[role="link"][aria-label^="Like."]');

    copyLinkToTweetLink.evaluate((el) => {
      const $actions = el.parentNode;
      const $copyLinkToTweet = $actions.querySelector('div[role="button"]');

      $copyLinkToTweet.parentNode.removeChild($copyLinkToTweet);
    });
  }

  const tweet = await frame.$('#app');

  const buffer = await tweet.screenshot({
    omitBackground: true,
    type: "png",
  });

  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Content-Length', buffer.length);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', `public, max-age=${SEND_CACHE_HEADER_FOR_SECONDS}, s-max-age=${SEND_CACHE_HEADER_FOR_SECONDS}`);

  return res.end(buffer);
}));

Promise.resolve()
  .then(async () => {
    BROWSER = await chromium.launch();
  })
  .then(() => {
    app.listen(
      PORT,
      HOST,
      () => {
        console.error(`|> Listening on http://${HOST}:${PORT}`);
      },
    );
  })
  ;
