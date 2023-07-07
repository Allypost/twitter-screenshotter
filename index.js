const {
  chromium: BrowserInstance,
  devices: { "Desktop Chrome": BrowserInfo },
} = require("playwright");
const fs = require("fs");
const https = require("node:https");
const express = require("express");
const bodyParser = require("body-parser");
const { StatusCodes } = require("http-status-codes");
const morgan = require("morgan");
const slowDown = require("express-slow-down");
const RedisStore = require("rate-limit-redis");
const axios = require("axios");

const HOST = process.env.HOST || "localhost";
const PORT = process.env.PORT || 8080;

const REQUESTS_PER_SECOND = 1;
const REQUESTS_MEASURE_WINDOW_SECONDS = 1 * 60; // 1 minute

const SEND_CACHE_HEADER_FOR_SECONDS = 15 * 60; // 15 minutes

const IS_DEV = process.env.NODE_ENV !== "production";

const BROWSER_INFO = {
  width: 1280,
  height: 720,
};

const SCREENSHOT_CONFIG = (() => {
  switch (BrowserInstance.name()) {
    case "chromium": {
      return {
        omitBackground: true,
        type: "png",
      };
    }

    default: {
      return {
        omitBackground: true,
        quality: 95,
        type: "jpeg",
      };
    }
  }
})();

const EMBED_HTML = fs.readFileSync("./embed.html", "utf-8");

class Logger {
  #logInstance = console.log;

  setLogger(log) {
    this.#logInstance = log;
  }

  #log(...args) {
    this.#logInstance(
      `[${new Date().toISOString()}]`,
      ...args.map((arg) => arg),
    );
  }

  debug(...args) {
    if (!IS_DEV) {
      return;
    }

    this.#log("[DEBUG]", ...args);
  }
}

const logger = new Logger();

/**
 * @type {(import "playwright").Browser}
 */
let BROWSER;

const asyncReq = (handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (e) {
    logger.debug(e);

    res.sendStatus(StatusCodes.INTERNAL_SERVER_ERROR);
  }

  try {
    await req.$browserContext?.close();
  } catch (e) {
    logger.debug(e);
  }
};
const app = express();

app.disable("x-powered-by");
app.enable("trust proxy");

app.use(morgan("combined"));

app.use(bodyParser.urlencoded());

const slowDownOptions = {
  windowMs: REQUESTS_MEASURE_WINDOW_SECONDS * 1000,
  delayAfter: REQUESTS_PER_SECOND * REQUESTS_MEASURE_WINDOW_SECONDS,
  delayMs: 734,
  headers: true,
};

if (process.env.REDIS_URL && String(process.env.REDIS_URL).trim().length > 0) {
  console.log("|>", process.env.REDIS_URL);
  slowDownOptions.store = new RedisStore({
    redisURL: process.env.REDIS_URL,
  });
}

const speedLimiter = slowDown(slowDownOptions);

const indexFile = fs.readFileSync("./index.html");

/**
 *
 * @param {(import "playwright").BrowserContext} context
 * @param {URL} url
 *
 * @returns {Promise<Buffer | null>} Screenshot buffer
 */
const renderTweetPage = async (context, url) => {
  logger.debug("Start rendering twitter page", url.toString());
  const page = await context.newPage();

  await page.goto(url.toString());

  await page.waitForSelector("data-testid=cellInnerDiv >> nth=0");

  if (
    !(await page.$("data-testid=cellInnerDiv >> nth=0 >> data-testid=tweet"))
  ) {
    logger.debug(
      "Tweet not available, reason:",
      await page
        .$("data-testid=cellInnerDiv >> nth=0")
        .then((el) => el.innerText()),
    );
    return null;
  }

  const tweet$ = await page.$(
    "data-testid=cellInnerDiv >> nth=0 >> data-testid=tweet >> ..",
  );

  // Remove bottom popups (eg. Accept cookies, sign in, etc.)
  {
    const layers$ = await page.$("#layers");

    await layers$.evaluate((el) => {
      el.parentNode.removeChild(el);
    });
  }

  // Remove tweet actions (eg. Like, Retweet, Reply, etc.)
  {
    await tweet$.evaluate(($tweet) => {
      const $likeBtn = $tweet.querySelector('[aria-label="Like"]');

      let $tweetActions = $likeBtn;
      while ($tweetActions && $tweetActions.getAttribute("role") !== "group") {
        $tweetActions = $tweetActions.parentNode;
      }

      if (!$tweetActions) {
        return;
      }

      $tweetActions.parentNode.removeChild($tweetActions);
    });
  }

  // Check for sensitive content popup
  {
    const clicked = await tweet$.evaluate(($tweet) => {
      const $settingsLink = $tweet.querySelector(
        'a[href="/settings/content_you_see"]',
      );

      if (!$settingsLink) {
        return false;
      }

      const $sensitiveContentPopup =
        $settingsLink.parentNode.parentNode.parentNode;
      const $viewBtn = $sensitiveContentPopup.querySelector('[role="button"]');

      $viewBtn.click();

      return true;
    });

    if (clicked) {
      logger.debug("Enabled sensitive content");
      await page.waitForResponse("https://*.twimg.com/**");
      await page.waitForLoadState("networkidle");
    }
  }

  // Add border radius to tweet to make it a bit more fancy
  {
    await tweet$.evaluate(($tweet) => {
      $tweet.style.borderRadius = "12px";
    });
  }

  return tweet$.screenshot(SCREENSHOT_CONFIG);
};

/**
 *
 * @param {(import "playwright").BrowserContext} context
 * @param {URL} url
 *
 * @returns {Promise<Buffer>} Screenshot buffer
 */
const renderTweetEmbedded = async (context, url) => {
  logger.debug("Start rendering embedded page", url.toString());

  const page = await context.newPage();
  await page.setContent(
    EMBED_HTML.replace("{{URL_FOR_TWITTER}}", url.toString()),
  );

  const tweetIframe = await page.waitForSelector(
    ".twitter-tweet-rendered iframe",
  );
  const frame = await tweetIframe.contentFrame();

  {
    const retweetLink = await frame
      .$$('a[role="link"]')
      .then((links) => links.pop());

    await retweetLink.evaluate((el) => {
      const $retweetDiv = el.parentNode;
      $retweetDiv.parentNode.removeChild($retweetDiv);
    });
  }

  {
    const copyLinkToTweetLink = await frame.$(
      'a[role="link"][aria-label^="Like."]',
    );

    await copyLinkToTweetLink.evaluate((el) => {
      const $actions = el.parentNode;
      const $copyLinkToTweet = $actions.querySelector('div[role="button"]');

      $copyLinkToTweet.parentNode.removeChild($copyLinkToTweet);
    });
  }

  // Show sensitive media
  {
    const tweetText$ = await frame.$("data-testid=tweetText");

    const clicked = await tweetText$.evaluate(($tweetText) => {
      const $tweetContents = $tweetText.parentNode.parentNode;
      const $viewBtn = $tweetContents.querySelector('[role="button"]');
      if (!$viewBtn || !$viewBtn.innerText === "View") {
        return false;
      }

      $viewBtn.click();
      return true;
    });

    if (clicked) {
      logger.debug("Enabled sensitive content");
      await page.waitForResponse("https://*.twimg.com/**");
      await page.waitForLoadState("networkidle");
    }
  }

  // Remove reply stuff
  {
    const tweetText$ = await frame.$("data-testid=tweetText");

    await tweetText$.evaluate(
      ($tweetText, data) => {
        const $backlinks = document.querySelectorAll(
          `a[href*="twitter.com${data.pathname}"]`,
        );

        for (const $backlink of $backlinks) {
          if (
            $backlink.textContent === "Read the full conversation on Twitter"
          ) {
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
      },
      {
        pathname: url.pathname,
      },
    );
  }

  // Remove Twitter branding
  {
    const body$ = await frame.$("body");
    await body$.evaluate(
      (document, data) => {
        const $backlinks = document.querySelectorAll(
          `a[href*="twitter.com${data.pathname}"]`,
        );
        for (const $backlink of $backlinks) {
          if ($backlink.textContent.includes("·")) {
            continue;
          }

          if ($backlink.querySelector('img[src^="https://pbs.twimg.com"]')) {
            continue;
          }

          $backlink.parentNode.removeChild($backlink);
        }

        const $infoBtn = document.querySelector(
          '[aria-label="Twitter Ads info and privacy"]',
        );
        if ($infoBtn) {
          $infoBtn.parentNode.removeChild($infoBtn);
        }

        const $followBtn = document.querySelector(
          'a[href^="https://twitter.com/intent/follow"]',
        );
        if ($followBtn) {
          const $followBtnContainer = $followBtn.parentNode;
          $followBtnContainer.parentNode.removeChild($followBtnContainer);
        }
      },
      {
        pathname: url.pathname,
      },
    );
  }

  const tweet = await frame.$("#app");

  return tweet.screenshot(SCREENSHOT_CONFIG);
};

/**
 *
 * @param {BrowserContext} context
 * @param {URL} url
 *
 * @returns {Promise<Buffer>} Screenshot buffer
 */
const renderTweet = (context, url) =>
  renderTweetPage(context, url).then(
    (data) => data || renderTweetEmbedded(context, url),
  );
app.get("/", (_req, res) => {
  res.end(indexFile);
});

const faviconFile = fs.readFileSync("./favicon.ico");
app.get("/favicon.ico", (_req, res) => {
  res.end(faviconFile);
});

app.post("/", (req, res) => {
  if (!req.body || !req.body.url) {
    return res.sendStatus(StatusCodes.UNSUPPORTED_MEDIA_TYPE);
  }

  res.redirect(`/${req.body.url}`);
});

/**
 *
 * @param {*} req
 * @param {*} res
 * @param {URL} url
 * @returns
 */
const handleNonTwitter = async (req, res, url) => {
  logger.debug("Non-twitter URL", url.toString());

  const urlPath = url.pathname.replace(/\/$/, "");
  const tootId = urlPath.split("/").pop() ?? "";

  if (!/^\d+$/.test(tootId)) {
    logger.debug("Invalid toot ID", tootId);
    return res.sendStatus(StatusCodes.UNPROCESSABLE_ENTITY);
  }

  const tootInfo = await axios
    .get(`https://${url.hostname}/api/v1/statuses/${tootId}`, {
      timeout: 5000,
      headers: {
        Accept: "application/json",
      },
    })
    .then((res) => res.data)
    .catch(() => null);

  if (!tootInfo) {
    logger.debug("Toot not found", tootId);
    return res.sendStatus(StatusCodes.NOT_FOUND);
  }

  const BROWSER_INFO = {
    width: 720,
    height: 2160,
  };
  const context = await BROWSER.newContext({
    acceptDownloads: false,
    locale: "en-US",
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

  const buffer = await (async (context, url) => {
    logger.debug("Start rendering Mastodon page", url.toString());
    const page = await context.newPage();

    await page.goto(url.toString());

    // await page.waitForSelector("#mastodon .detailed-status__wrapper");
    await page.waitForLoadState("networkidle");

    const toot$ = await page.$("#mastodon .detailed-status__wrapper");

    if (!toot$) {
      logger.debug("Toot not available");
      return null;
    }

    const container$ = await toot$.evaluateHandle(($el) => {
      let $container = $el;
      while (
        ($container && !$container.classList.contains("scrollable")) ||
        $container === document
      ) {
        $container = $container.parentNode;
      }

      return $container;
    });
    console.log({ container$, container: await container$?.innerHTML() });

    // Remove replies to toot and add style to container
    {
      await container$.evaluate(($el) => {
        console.log({ $container: $el });
        $el.querySelectorAll(".status__wrapper-reply").forEach(($reply) => {
          console.log({ $reply });
          while ($reply && $reply.parentNode !== $el) {
            $reply = $reply.parentNode;
          }
          $reply?.remove();
        });

        $el.style.flex = "0";
      });
    }
    // Remove toot actions (eg. Like, Retweet, Reply, etc.)
    {
      await container$.evaluate(($el) => {
        $el
          .querySelectorAll(".status__action-bar, .detailed-status__action-bar")
          .forEach(($actions) => {
            $actions?.remove();
          });
      });
    }
    // Expand all spoilers
    {
      await container$.evaluate(($el) => {
        $el
          .querySelectorAll(
            'button.status__content__spoiler-link[aria-expanded="false"]',
          )
          .forEach(($action) => {
            $action?.click();
          });
      });
    }
    // Click on all spoiler buttons
    {
      await container$.evaluate(($el) => {
        $el
          .querySelectorAll(
            '.spoiler-button > button[class="spoiler-button__overlay"]',
          )
          .forEach(($spoilerBtn) => {
            $spoilerBtn?.click();
          });
      });
      await page.waitForLoadState("networkidle");
    }
    // Remove image spoiler button if shown
    {
      await container$.evaluate(($el) => {
        $el
          .querySelectorAll(".spoiler-button--minified")
          .forEach(($actions) => {
            $actions?.remove();
          });
      });
    }

    return container$.screenshot(SCREENSHOT_CONFIG);
  })(context, url).catch(() => null);

  if (!buffer) {
    return res.sendStatus(StatusCodes.NOT_FOUND);
  }

  res.setHeader("Content-Type", `image/${SCREENSHOT_CONFIG.type}`);
  res.setHeader("Content-Length", buffer.length);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Cache-Control",
    `public, max-age=${SEND_CACHE_HEADER_FOR_SECONDS}, s-max-age=${SEND_CACHE_HEADER_FOR_SECONDS}`,
  );

  return res.end(buffer);
};

app.get(
  "/*",
  speedLimiter,
  asyncReq(async (req, res) => {
    /**
     * @type {URL | null}
     */
    let parsedUrl = null;
    {
      const twitterUrl = req.params[0];
      try {
        logger.debug("Starting processing", twitterUrl);

        parsedUrl = new URL(twitterUrl);
      } catch (e) {
        logger.debug("URL parse failed", twitterUrl, e);
      }
    }

    if (!parsedUrl) {
      return res.sendStatus(StatusCodes.BAD_REQUEST);
    }

    if (parsedUrl.protocol !== "https:") {
      parsedUrl.protocol = "https:";
    }

    if (parsedUrl.hostname !== "twitter.com") {
      return handleNonTwitter(req, res, parsedUrl);
    }

    const tweetUrlMatch = parsedUrl.pathname.match(
      /^\/\w{4,15}\/status\/(?<id>\d+)$/,
    );
    if (!tweetUrlMatch) {
      return res.sendStatus(StatusCodes.FORBIDDEN);
    }

    const tweetId = tweetUrlMatch.groups.id;
    {
      /**
       * @type {object | null}
       */
      const tweetInfo = await new Promise((resolve) => {
        const url = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&lang=en`;

        https.get(
          url,
          {
            headers: {
              "User-Agent": BrowserInfo.userAgent,
              Accept: "application/json",
            },
          },
          (res) => {
            if (res.statusCode !== StatusCodes.OK) {
              return resolve(null);
            }

            res.setEncoding("utf8");
            let rawData = "";
            res.on("data", (chunk) => {
              rawData += chunk;
            });
            res.on("end", () => {
              try {
                resolve(JSON.parse(rawData));
              } catch {
                resolve(null);
              }
            });
          },
        );
      });

      logger.debug("Tweet info", tweetInfo);

      if (!tweetInfo) {
        return res.sendStatus(StatusCodes.NOT_FOUND);
      }
    }

    const context = await BROWSER.newContext({
      acceptDownloads: false,
      locale: "en-US",
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

    const buffer = await renderTweet(context, parsedUrl);

    res.setHeader("Content-Type", `image/${SCREENSHOT_CONFIG.type}`);
    res.setHeader("Content-Length", buffer.length);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Cache-Control",
      `public, max-age=${SEND_CACHE_HEADER_FOR_SECONDS}, s-max-age=${SEND_CACHE_HEADER_FOR_SECONDS}`,
    );

    return res.end(buffer);
  }),
);

if (IS_DEV) {
  console.clear();
}

Promise.resolve()
  .then(async () => {
    BROWSER = await BrowserInstance.launch();
  })
  .then(() => {
    app.listen(PORT, HOST, () => {
      console.error(`|> Listening on http://${HOST}:${PORT}`);
    });
  });
