const {
  chromium: BrowserInstance,
  Browser,
} = require('playwright');
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

const BROWSER_INFO = {
  width: 2160,
  height: 3840,
  screenshotType:
    BrowserInstance.name === 'chromium'
      ? 'png'
      : 'jpeg'
  ,
};

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
        await req.$browserContext.close();
      } catch { }
    }
  }
  ;

const app = express();

app.disable('x-powered-by');
app.enable("trust proxy");

app.use(morgan('combined'));

app.use(bodyParser.urlencoded());

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

const indexFile = fs.readFileSync("./index.html");

app.get("/", (req, res) => {
  res
    .end(indexFile);
});

const faviconFile = fs.readFileSync("./favicon.ico");
app.get('/favicon.ico', (req, res) => {
  res
    .end(faviconFile);
})

app.post("/", (req, res) => {
  if (!req.body || !req.body.url) {
    return res.sendStatus(StatusCodes.UNSUPPORTED_MEDIA_TYPE);
  }

  res.redirect(`/${req.body.url}`).end();
});

app.get("/*", speedLimiter, asyncReq(async (req, res) => {
  const twitterUrl = req.params[0];

  if (!twitterUrl) {
    return res.sendStatus(StatusCodes.FORBIDDEN);
  }

  const parsedUrl = new URL(twitterUrl);

  if (parsedUrl.hostname !== 'twitter.com') {
    return res.sendStatus(StatusCodes.FORBIDDEN);
  }

  const context = await BROWSER.newContext({
    acceptDownloads: false,
    locale: 'en-US',
    viewport: {
      width: BROWSER_INFO.width,
      height: BROWSER_INFO.height,
    },
    screen: {
      width: BROWSER_INFO.width,
      height: BROWSER_INFO.height,
    },
  });
  req.$browserContext = context;

  const page = await context.newPage();
  await page.setContent(EMBED_HTML.replace(
    '{{URL_FOR_TWITTER}}',
    twitterUrl,
  ));

  const tweetIframe = await page.waitForSelector('.twitter-tweet-rendered iframe');
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

  // Show sensitive media
  {
    const tweetText$ = await frame.$('data-testid=tweetText');

    const clicked = await tweetText$.evaluate(($tweetText) => {
      const $tweetContents = $tweetText.parentNode.parentNode;
      const $viewBtn = $tweetContents.querySelector('[role="button"]');
      if (!$viewBtn || !$viewBtn.innerText === 'View') {
        return false;
      }

      $viewBtn.click();
      return true;
    });

    if (clicked) {
      const req = await page.waitForRequest('https://*.twimg.com/**');
      await req.response();
    }
  }

  // Remove reply stuff
  {
    const tweetText$ = await frame.$('data-testid=tweetText');

    await tweetText$.evaluate(($tweetText, data) => {
      const $backlinks = document.querySelectorAll(`a[href*="twitter.com${data.pathname}"]`);

      for (const $backlink of $backlinks) {
        if ($backlink.textContent === 'Read the full conversation on Twitter') {
          const $container = $backlink.parentNode.parentNode;
          $container.parentNode.removeChild($container);
          break;
        }
      }

      const $tweetContents = $tweetText.parentNode.parentNode;
      const $tweet = $tweetContents.parentNode;

      const hasSiblings = $tweet.childNodes.length > 1;

      if (!hasSiblings) {
        return;
      }

      $tweet.removeChild($tweet.childNodes[0]);
    }, {
      pathname: parsedUrl.pathname,
    });
  }

  // Remove Twitter branding
  {
    const body$ = await frame.$('body');
    await body$.evaluate((document, data) => {
      const $backlinks = document.querySelectorAll(`a[href*="twitter.com${data.pathname}"]`);
      for (const $backlink of $backlinks) {
        if ($backlink.textContent.includes('·')) {
          continue;
        }

        if ($backlink.querySelector('img[src^="https://pbs.twimg.com"]')) {
          continue;
        }

        $backlink.parentNode.removeChild($backlink);
      }

      const $infoBtn = document.querySelector('[aria-label="Twitter Ads info and privacy"]');
      if ($infoBtn) {
        $infoBtn.parentNode.removeChild($infoBtn);
      }

      const $followBtn = document.querySelector('a[href^="https://twitter.com/intent/follow"]');
      if ($followBtn) {
        const $followBtnContainer = $followBtn.parentNode;
        $followBtnContainer.parentNode.removeChild($followBtnContainer);
      }
    }, {
      pathname: parsedUrl.pathname,
    });
  }

  const tweet = await frame.$('#app');

  const buffer = await tweet.screenshot({
    omitBackground: true,
    quality: 95,
    type: BROWSER_INFO.screenshotType,
  });

  res.setHeader('Content-Type', `image/${BROWSER_INFO.screenshotType}`);
  res.setHeader('Content-Length', buffer.length);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', `public, max-age=${SEND_CACHE_HEADER_FOR_SECONDS}, s-max-age=${SEND_CACHE_HEADER_FOR_SECONDS}`);

  return res.end(buffer);
}));

Promise.resolve()
  .then(async () => {
    BROWSER = await BrowserInstance.launch();
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
