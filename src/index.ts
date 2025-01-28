import {
  firefox as BrowserInstance,
  devices as BrowserDevices,
  type BrowserContextOptions,
  type Browser,
  type BrowserContext,
} from "playwright";
import https from "node:https";
import express from "express";
import { urlencoded as bodyParserUrlencoded } from "body-parser";
import { StatusCodes } from "http-status-codes";
import morgan from "morgan";
import {
  slowDown,
  type SlowDownInfo,
  type Options as SlowDownOptions,
} from "express-slow-down";
import { RedisStore } from "rate-limit-redis";
import axios from "axios";
import { z } from "zod";
import type { Request, Response } from "express";
import { createClient } from "redis";
import { Agent, type AtpSessionData, CredentialSession } from "@atproto/api";
import { type PostView } from "@atproto/api/dist/client/types/app/bsky/feed/defs";
import indexHtmlPath from "./assets/index.html";
import embedHtmlPath from "./assets/embed.html";
import faviconPath from "./assets/favicon.ico";

const EMBED_HTML = await Bun.file(embedHtmlPath).text();
const INDEX_HTML = await Bun.file(indexHtmlPath).text();
const FAVICON_BLOB = await Bun.file(faviconPath).bytes();

const BrowserInfo = BrowserDevices["Desktop Chrome"];

const HOST = process.env.HOST || "localhost";
const PORT = Number(process.env.PORT || 8080);
const LOG_LEVELS = ["trace", "debug", "info", "warn", "error"] as const;
const LOG_LEVELS_RANK = Object.fromEntries(
  LOG_LEVELS.map((level, i) => [level, i]),
) as Record<LogLevel, number>;
type LogLevel = (typeof LOG_LEVELS)[number];
const LOG_LEVEL = (process.env.LOG_LEVEL || "info") as LogLevel;
const LOG_LEVEL_REQUIRED_RANK = LOG_LEVELS_RANK[LOG_LEVEL];

if (!LOG_LEVELS.includes(LOG_LEVEL)) {
  console.warn("Invalid LOG_LEVEL", LOG_LEVEL);
  console.warn("Allowed LOG_LEVELS: ", LOG_LEVELS);
  process.exit(1);
}

const REQUESTS_PER_SECOND = 1;
const REQUESTS_MEASURE_WINDOW_SECONDS = 1 * 60; // 1 minute

const SEND_CACHE_HEADER_FOR_SECONDS = 15 * 60; // 15 minutes

const IS_DEV = process.env.NODE_ENV !== "production";

const BROWSER_INFO = {
  width: 1152,
  height: 1536,
};

let BSKY_AGENT: Agent;
let BSKY_SESSION_DATA: string | null = null;

const SCREENSHOT_CONFIG = (() => {
  switch (BrowserInstance.name()) {
    // case "chromium": {
    //   return {
    //     omitBackground: true,
    //     type: "png",
    //   } as const;
    // }

    default: {
      return {
        omitBackground: false,
        quality: 85,
        type: "jpeg",
      } as const;
    }
  }
})();

type LoggerTag = Record<string, string | null>;
class Logger {
  private logInstance = console.log;
  private tags: Record<string, string | null> = {};
  private tagsStr = "";

  setLogger(log: (...args: any[]) => any) {
    this.logInstance = log;
    return this;
  }

  #log(level: LogLevel, ...args: any[]) {
    const levelRank = LOG_LEVELS_RANK[level];
    if (levelRank < LOG_LEVEL_REQUIRED_RANK) {
      return;
    }

    this.logInstance(
      `[${new Date().toISOString()}]`,
      `[${level}]`,
      this.tagsStr,
      ...args.map((arg) => arg),
    );
  }

  setTags(tags: LoggerTag | string) {
    if (typeof tags === "string") {
      tags = {
        [tags]: null,
      };
    }

    this.tags = { ...this.tags, ...tags };
    this.tagsStr = Object.entries(this.tags)
      .map(([key, value]) =>
        value !== null ? `[${key}=${JSON.stringify(value)}]` : `[${key}]`,
      )
      .join(" ");
    return this;
  }

  clearTags(...tags: (keyof LoggerTag)[]) {
    for (const tag of tags) {
      delete this.tags[tag];
    }
  }

  subTagged(tags: LoggerTag | string) {
    if (typeof tags === "string") {
      tags = {
        [tags]: null,
      };
    }

    return new Logger()
      .setLogger(this.logInstance)
      .setTags({ ...this.tags, ...tags });
  }

  getTags() {
    return { ...this.tags };
  }

  trace(...args: any[]) {
    this.#log("trace", ...args);
  }

  debug(...args: any[]) {
    this.#log("debug", ...args);
  }

  info(...args: any[]) {
    this.#log("info", ...args);
  }

  warn(...args: any[]) {
    this.#log("warn", ...args);
  }

  error(...args: any[]) {
    this.#log("error", ...args);
  }
}

const globalLogger = new Logger();

let BROWSER: Browser;

type AppRequest = Request & {
  $browserContext: BrowserContext | null | undefined;
  $seenUrls: string[] | undefined;
  $logger: Logger;
  $id: string;
  slowDown?: SlowDownInfo;
};

type AppResponse = Response;

const newBrowserContext = (options?: BrowserContextOptions) => {
  return BROWSER.newContext({
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
    colorScheme: "dark",
    // reducedMotion: "reduce",
    ...options,
  }).then((ctx) => {
    ctx.setDefaultNavigationTimeout(35_000);

    return ctx;
  });
};

type AppHandler = (req: AppRequest, res: AppResponse) => any;

const asyncReq =
  (handler: AppHandler, onFinished?: AppHandler) =>
  async (rreq: Request, rres: Response) => {
    const req = rreq as AppRequest;
    const res = rres as AppResponse;

    const logger = req.$logger;

    try {
      await handler(req, res);
    } catch (e) {
      logger.warn("Handler failed", e);

      res.sendStatus(StatusCodes.INTERNAL_SERVER_ERROR);
    } finally {
      try {
        onFinished?.(req, res);
      } catch {}
    }

    try {
      await req.$browserContext?.close();
      req.$browserContext = null;
      logger.debug("Closed browser context");
    } catch (e) {
      logger.warn("Failed to close browser context", e);
    }
  };

type Renderer = (
  context: BrowserContext,
  url: URL,
  logger: Logger,
) => Promise<Buffer | null | undefined>;

const renderTweetPage: Renderer = async (context, url, logger) => {
  logger.debug("Start rendering twitter page", url.toString());
  const page = await context.newPage();

  await page.goto(url.toString());

  await page.waitForLoadState("networkidle");

  if (
    !(await page.$("data-testid=cellInnerDiv >> nth=0 >> data-testid=tweet"))
  ) {
    logger.debug(
      "Tweet not available, reason:",
      await page
        .$("data-testid=cellInnerDiv >> nth=0")
        .then((el) => el?.innerText()),
    );
    return null;
  }

  const tweet$ = await page.$(
    "data-testid=cellInnerDiv >> nth=0 >> data-testid=tweet >> ..",
  );

  if (!tweet$) {
    logger.warn("Tweet element not found");

    return null;
  }

  // Remove bottom popups (eg. Accept cookies, sign in, etc.)
  {
    const layers$ = await page.$("#layers");

    await layers$?.evaluate((el) => {
      el.parentNode?.removeChild(el);
    });
  }

  // Remove Follow button and dots
  {
    const layers$ = await page.$('[data-testid="User-Name"]');

    if (layers$) {
      await layers$.evaluate(($username) => {
        let $node = $username.parentNode;
        while (
          $node &&
          $node !== document.body &&
          $node.childElementCount === 1
        ) {
          $node = $node.parentElement;
        }

        if (!$node) {
          return;
        }

        const $lastChild = $node.lastChild;

        $lastChild?.parentElement?.removeChild($lastChild);
      });
    }
  }

  // Remove everything below tweet meta (reposts, quotes, likes, etc.)
  {
    await tweet$.evaluate(($tweet) => {
      const $tweetMeta = $tweet.querySelector(
        '*[role="group"]:has([role="separator"])',
      );

      let $nextElement = $tweetMeta?.nextSibling;
      while ($nextElement) {
        let $elementToRemove = $nextElement;
        $nextElement = $nextElement.nextSibling; // Move to the next sibling
        $elementToRemove.parentNode?.removeChild($elementToRemove); // Remove the current sibling
      }
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
        $settingsLink.parentNode?.parentNode?.parentNode;
      const $viewBtn =
        $sensitiveContentPopup?.querySelector<HTMLElement>('[role="button"]');

      $viewBtn?.click();

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
      $tweet.style.marginBottom = "2px";
    });
  }

  // // Remove "Read $NUM replies" thing
  {
    await tweet$.evaluate(($tweet) => {
      $tweet
        .querySelector('[data-testid="logged_out_read_replies_pivot"]')
        ?.remove();
    });
  }

  // Remove share button
  {
    await tweet$.evaluate(($tweet) => {
      const $shareBtn = $tweet.querySelector('[aria-label="Share post"]')
        ?.parentElement?.parentElement;
      const $siblings = $shareBtn?.parentElement?.children;

      $shareBtn?.remove();

      if (!$siblings) {
        return;
      }

      for (let i = 0; i < $siblings.length; i++) {
        const $sibling = $siblings.item(i) as HTMLElement;
        if (!$sibling) {
          continue;
        }

        $sibling.style.justifyContent = "center";
      }
    });
  }

  await page
    .$('div[aria-label="Home timeline"] > :nth-child(1)')
    .then((el$) => el$?.evaluate(($el) => $el.remove()));

  return tweet$.screenshot(SCREENSHOT_CONFIG);
};

const renderTweetEmbedded: Renderer = async (context, url, logger) => {
  logger.debug("Start rendering embedded page", url.toString());

  const page = await context.newPage();
  await page.setContent(
    EMBED_HTML.replace("{{URL_FOR_TWITTER}}", url.toString()),
  );

  await page.waitForLoadState("networkidle");
  const tweetIframe = await page.waitForSelector(
    ".twitter-tweet-rendered iframe",
  );
  const frame = (await tweetIframe.contentFrame())!;

  {
    const retweetLink = await frame
      .$$('a[role="link"]')
      .then((links) => links.pop());

    if (retweetLink)
      await retweetLink.evaluate((el) => {
        const $retweetDiv = el.parentNode;
        $retweetDiv?.parentNode?.removeChild($retweetDiv);
      });
  }

  {
    const copyLinkToTweetLink = await frame.$(
      'a[role="link"][aria-label^="Like."]',
    );

    if (copyLinkToTweetLink)
      await copyLinkToTweetLink.evaluate((el) => {
        const $actions = el.parentNode;
        const $copyLinkToTweet = $actions?.querySelector('div[role="button"]');

        $copyLinkToTweet?.parentNode?.removeChild($copyLinkToTweet);
      });
  }

  // Show sensitive media
  {
    const tweetText$ = await frame.$("data-testid=tweetText");

    const clicked = await tweetText$?.evaluate(($tweetText) => {
      const $tweetContents = $tweetText.parentNode?.parentNode;
      const $viewBtn =
        $tweetContents?.querySelector<HTMLElement>('[role="button"]');
      if (!$viewBtn || $viewBtn.innerText !== "View") {
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

    await tweetText$?.evaluate(
      ($tweetText, data) => {
        const $backlinks = document.querySelectorAll(
          `a[href*="twitter.com${data.pathname}"]`,
        );

        for (const $backlink of $backlinks) {
          if (
            $backlink.textContent === "Read the full conversation on Twitter"
          ) {
            const $container = $backlink.parentNode?.parentNode;
            $container?.parentNode?.removeChild($container);
            break;
          }
        }

        const $tweetContents = $tweetText.parentNode?.parentNode;
        const $tweet = $tweetContents?.parentNode;

        const hasSiblings = $tweet && $tweet.childNodes.length > 1;

        if (!hasSiblings) {
          return;
        }

        $tweet.removeChild($tweet.childNodes[0]!);
      },
      {
        pathname: url.pathname,
      },
    );
  }

  // Remove Twitter branding
  {
    const body$ = await frame.$("body");
    await body$?.evaluate(
      (document, data) => {
        const $backlinks = document.querySelectorAll(
          `a[href*="twitter.com${data.pathname}"]`,
        );
        for (const $backlink of $backlinks) {
          if ($backlink.textContent?.includes("·")) {
            continue;
          }

          if ($backlink.querySelector('img[src^="https://pbs.twimg.com"]')) {
            continue;
          }

          $backlink.parentNode?.removeChild($backlink);
        }

        const $infoBtn = document.querySelector(
          '[aria-label="Twitter Ads info and privacy"]',
        );
        if ($infoBtn) {
          $infoBtn.parentNode?.removeChild($infoBtn);
        }

        const $followBtn = document.querySelector(
          'a[href^="https://twitter.com/intent/follow"]',
        );
        if ($followBtn) {
          const $followBtnContainer = $followBtn.parentNode;
          $followBtnContainer?.parentNode?.removeChild($followBtnContainer);
        }
      },
      {
        pathname: url.pathname,
      },
    );
  }

  const tweet = (await frame.$("#app"))!;

  return tweet.screenshot(SCREENSHOT_CONFIG);
};

const renderTweet: Renderer = (context, url, logger) =>
  renderTweetPage(context, url, logger).then(
    (data) => data || renderTweetEmbedded(context, url, logger),
  );

type RequestHandler = (req: AppRequest, res: AppResponse, url: URL) => unknown;

const handleMastodonToot: RequestHandler = async (req, res, url) => {
  const urlPath = url.pathname.replace(/\/$/, "");
  const tootId = urlPath.split("/").pop() ?? "";

  const logger = req.$logger.subTagged({ mastodon: tootId });

  logger.debug("Toot URL", url.toString());

  if (!/^\d+$/.test(tootId)) {
    logger.debug("Invalid toot ID", tootId);
    return res.sendStatus(StatusCodes.UNPROCESSABLE_ENTITY);
  }

  const tootInfoValidator = z.object({
    url: z.string().url(),
  });
  const tootInfo = await axios
    .get(`https://${url.hostname}/api/v1/statuses/${tootId}`, {
      timeout: 5000,
      headers: {
        Accept: "application/json",
      },
    })
    .then((res) => res.data)
    .then(tootInfoValidator.parseAsync)
    .catch(() => null);

  if (!tootInfo) {
    logger.debug("Toot not found", tootId);
    return res.sendStatus(StatusCodes.NOT_FOUND);
  }

  const tootUrl = new URL(tootInfo.url);

  if (tootUrl.hostname !== url.hostname) {
    logger.debug(
      "Toot URL not from this instance, replacing",
      url.hostname,
      "->",
      tootUrl.hostname,
    );

    return handleActivityPub(req, res, tootUrl);
  }

  const context = await newBrowserContext();
  req.$browserContext = context;

  const buffer = await (async (context, url) => {
    logger.debug("Start rendering Mastodon page", url.toString());
    const page = await context.newPage();

    await page.goto(url.toString());

    await page.waitForLoadState("networkidle");

    const toot$ = await page
      .$("#mastodon .detailed-status__wrapper")
      .catch(() => null);

    if (!toot$) {
      logger.debug("Toot not available");
      return null;
    }

    // Remove global toolbars
    {
      await page.evaluate(() => {
        document.querySelector(".tabs-bar__wrapper")?.remove();
        document.querySelector(".ui__header")?.remove();
      });
    }

    const container$ =
      (await page.$("#mastodon .scrollable:has(.detailed-status__wrapper)")) ??
      toot$;

    // Remove replies to toot and add style to container
    {
      await container$.evaluate(($container) => {
        const $mainEl = $container.querySelector(
          "*:has(.detailed-status__wrapper)",
        );

        let nextElement = $mainEl?.nextSibling;
        while (nextElement) {
          let elementToRemove = nextElement;
          nextElement = nextElement.nextSibling; // Move to the next sibling
          elementToRemove.parentNode?.removeChild(elementToRemove); // Remove the current sibling
        }

        $container.style.flex = "0";
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
          .querySelectorAll<HTMLElement>(
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
          .querySelectorAll<HTMLElement>(
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
  })(context, tootInfo.url).catch(() => null);

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
  res.setHeader(
    "Content-Disposition",
    `inline; filename="toot.${url.hostname}.${tootId}.${SCREENSHOT_CONFIG.type}"`,
  );

  return res.end(buffer);
};

const handleTwitterTweet: RequestHandler = async (req, res, url) => {
  const logger = req.$logger.subTagged("twitter");
  const tweetUrlMatch = url.pathname.match(/^\/\w{4,15}\/status\/(?<id>\d+)$/);
  if (!tweetUrlMatch) {
    logger.debug("Invalid tweet URL", url.toString());
    return res.sendStatus(StatusCodes.FORBIDDEN);
  }

  const tweetId = tweetUrlMatch.groups!.id!;
  logger.setTags({ twitter: tweetId });
  logger.debug("Tweet ID", tweetId);
  {
    /**
     * @type {object | null}
     */
    const tweetInfo = await new Promise((resolve) => {
      const url = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&lang=en`;

      logger.debug("Tweet info URL", url);

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
            logger.debug("Tweet info request failed", res.statusCode);
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

  const context = await newBrowserContext();
  req.$browserContext = context;

  const buffer = await renderTweet(context, url, logger);

  if (!buffer) {
    return res
      .status(StatusCodes.INTERNAL_SERVER_ERROR)
      .send("Screenshot could not be taken");
  }

  res.setHeader("Content-Type", `image/${SCREENSHOT_CONFIG.type}`);
  res.setHeader("Content-Length", buffer.length);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Cache-Control",
    `public, max-age=${SEND_CACHE_HEADER_FOR_SECONDS}, s-max-age=${SEND_CACHE_HEADER_FOR_SECONDS}`,
  );
  res.setHeader(
    "Content-Disposition",
    `inline; filename="tweet.${tweetId}.${SCREENSHOT_CONFIG.type}"`,
  );

  return res.end(buffer);
};

const handleTumblrPost: RequestHandler = async (req, res, url) => {
  const logger = req.$logger.subTagged("tumblr");
  {
    // /post/<user>/<post-id>(/<post-slug>)
    const [_constPostStr, postUser, postId] = url.pathname.split("/");
    logger.setTags({ tumblr: `${postId}@${postUser}` });
  }
  logger.debug("Tumblr URL", url.toString());

  const context = await newBrowserContext();
  req.$browserContext = context;

  const buffer = await (async (context, url) => {
    logger.debug("Start rendering Tumblr page", url.toString());
    const page = await context.newPage();

    logger.debug("Navigate to Tumblr post", url.toString());
    await page.goto(url.toString());

    logger.debug("Wait for page to fully load");
    await page.waitForLoadState("networkidle");

    const post$ = await page
      .$('article:has(header[role="banner"] + div + div)')
      .catch((e) => {
        logger.debug("Error getting banner", e);
      });

    if (!post$) {
      logger.debug("Post not found");
      return null;
    }
    logger.debug("Got post");

    // Remove three dots and "follow" from post header
    {
      logger.debug("Remove three dots and follow from post header");
      const header$ = await post$.$('header[role="banner"]').catch(() => null);

      if (header$) {
        await header$
          .evaluate(($header) => {
            $header.querySelector('[aria-label="More options"]')?.remove();
            $header.querySelector('[aria-label="Follow"]')?.remove();
          })
          .catch((e) => {
            logger.debug('Remove three dots and "follow" from post header', e);
          });
      }
    }

    // Prevent margin collapse on post (should restore bottom "padding")
    {
      logger.debug("Prevent margin collapse on post");
      await post$
        .evaluate(($post) => {
          $post.style.paddingBottom = "1px";
        })
        .catch((e) => {
          logger.debug("Prevent margin collapse on post error", e);
        });
    }

    // Remove alt text thing
    {
      logger.debug("Remove alt text thing");
      await post$
        .evaluate(() => {
          document
            .querySelectorAll('[data-alt-text-popover="true"]')
            .forEach((e) => e.remove());
        })
        .catch((e) => {
          logger.debug("Remove alt text thing error", e);
        });
    }

    // Expand tags
    {
      logger.debug("Expand tags");
      await post$
        .evaluate(($post) => {
          $post
            .querySelector<HTMLElement>(
              '[data-testid="tag-link"] + a[role="button"]',
            )
            ?.click();
        })
        .catch((e) => {
          logger.debug("Expand tags error", e);
        });
    }

    // Clean up notes/footer section
    {
      logger.debug("Clean up notes/footer section");
      const footer$ = await post$
        .$('footer[role="contentinfo"]')
        .catch(() => null);

      if (footer$) {
        await footer$
          .evaluate(($footer) => {
            $footer.firstChild?.remove();

            const $pa = $footer.querySelector<HTMLElement>(
              '[aria-label="Post Activity"]',
            );
            if ($pa) {
              $pa.style.height = "auto";

              $pa
                .querySelector(
                  '[data-testid="desktop-selector"], [data-testid="mobile-selector"]',
                )
                ?.remove();

              $pa.querySelector('[role="tab"][title="Reblog Graph"]')?.remove();

              $pa.querySelector('[data-testid="notes-root"]')?.remove();

              const $repliesTab = $pa.querySelector<HTMLElement>(
                '[role="tab"][title="Replies"]',
              );
              const $tabItem = $pa.querySelector<HTMLElement>(
                '[role="tab"] + [role="tab"]',
              );
              if ($tabItem && $repliesTab) {
                $repliesTab.className = $tabItem.className;
              }
            }
          })
          .catch((e) => {
            logger.debug("Clean up notes/footer section error", e);
          });
      }
    }

    // Remove screen overlay
    {
      logger.debug("Remove screen overlay");
      await page
        .evaluate(() => {
          document.querySelector(".components-modal__screen-overlay")?.remove();
          document.querySelector("body > #cmp-app-container")?.remove();

          let signupOverlay = document.querySelector(
            '[aria-label="Sign me up"] + [aria-label="Log in"]',
          );
          while (signupOverlay) {
            let parent = signupOverlay.parentElement?.parentElement;
            if (parent?.dataset?.["testid"] === "scroll-container") {
              signupOverlay.remove();
              break;
            }
            signupOverlay = signupOverlay.parentElement;
          }
        })
        .catch((e) => {
          logger.debug("Remove screen overlay error", e);
        });
    }

    logger.debug("Screenshot post");
    return post$.screenshot(SCREENSHOT_CONFIG);
  })(context, url).catch((e) => {
    logger.debug("Failed to screenshot post", e);
    return null;
  });

  if (!buffer) {
    return res.sendStatus(StatusCodes.NOT_FOUND);
  }

  logger.debug("Sending response");

  res.setHeader("Content-Type", `image/${SCREENSHOT_CONFIG.type}`);
  res.setHeader("Content-Length", buffer.length);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Cache-Control",
    `public, max-age=${SEND_CACHE_HEADER_FOR_SECONDS}, s-max-age=${SEND_CACHE_HEADER_FOR_SECONDS}`,
  );
  const [username, postId] = url.pathname.replace(/^\/*/, "").split("/");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="tumblr.${username}.${postId}.${SCREENSHOT_CONFIG.type}"`,
  );

  return res.end(buffer);
};

const handleMisskeyPost: RequestHandler = async (req, res, url) => {
  const urlPath = url.pathname.replace(/\/$/, "");
  const postId = urlPath.split("/").pop() ?? "";

  const logger = req.$logger.subTagged({ misskey: postId });
  logger.debug("Misskey post", url.toString());

  const context = await newBrowserContext();
  req.$browserContext = context;

  const buffer = await (async (context, url) => {
    logger.debug("Start rendering Misskey page", url.toString());
    const page = await context.newPage();

    await page.goto(url.toString());

    await page.waitForLoadState("networkidle");

    const post$ = await page.$("main article").catch(() => null);

    if (!post$) {
      logger.debug("Post not available");
      return null;
    }

    const container$ = await post$.evaluateHandle(($post) => {
      const $parent = $post.parentElement as HTMLElement;
      return $parent;
    });

    if (!(await container$.evaluate((x) => x))) {
      logger.debug("Container not found");
      return null;
    }

    // Remove sticky header
    {
      await page.evaluate(() => {
        document.querySelector("main > div > div")?.remove();
      });
    }

    // Remove everything except the post from the container
    {
      await container$.evaluate(($container) => {
        let nextElement = $container?.firstChild;
        while (nextElement) {
          let elementToRemove = nextElement;
          nextElement = nextElement.nextSibling; // Move to the next sibling
          if (elementToRemove) {
            elementToRemove.parentNode?.removeChild(elementToRemove); // Remove the current sibling
          }
        }
      });
    }

    // Remove replies to post
    {
      await post$.evaluate(($post) => {
        let nextElement = $post?.nextSibling;
        while (nextElement) {
          let elementToRemove = nextElement;
          nextElement = nextElement.nextSibling; // Move to the next sibling
          elementToRemove.parentNode?.removeChild(elementToRemove); // Remove the current sibling
        }
      });
    }

    // Remove pure post actions and add style to footer
    {
      await container$.evaluate(($container) => {
        const $footers = $container?.querySelectorAll("footer") ?? [];
        for (const $footer of $footers) {
          let nextElement =
            $footer.parentElement?.querySelector("footer > button")?.nextSibling
              ?.nextSibling;
          while (nextElement) {
            let elementToRemove = nextElement;
            nextElement = nextElement.nextSibling; // Move to the next sibling
            elementToRemove.parentNode?.removeChild(elementToRemove); // Remove the current sibling
          }

          $footer.style.justifyContent = "flex-start";
        }
      });
    }

    // Open all summaries
    {
      await container$.evaluate(($container) => {
        $container
          .querySelectorAll<HTMLElement>("details > summary")
          .forEach(($summary) => {
            $summary.click();
            $summary.style.display = "none";
          });
      });

      await page.waitForLoadState("networkidle");
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
  res.setHeader(
    "Content-Disposition",
    `inline; filename="misskey-post.${url.hostname}.${postId}.${SCREENSHOT_CONFIG.type}"`,
  );

  return res.end(buffer);
};

const getNodeInfo = async (url: URL, logger: Logger) => {
  const nodeInfoListValidator = z.object({
    links: z.array(
      z.object({
        rel: z.string(),
        href: z.string().url(),
      }),
    ),
  });

  const nodeInfoListUrl = `${url.protocol}//${url.hostname}/.well-known/nodeinfo`;
  const nodeInfoList = await axios
    .get(nodeInfoListUrl, {
      timeout: 5000,
      headers: {
        Accept: "application/json",
      },
    })
    .then((res) => res)
    .then((res) => res.data)
    .then(nodeInfoListValidator.parseAsync)
    .catch(() => null);

  logger.debug(
    `Got node info from ${nodeInfoListUrl}`,
    JSON.stringify(nodeInfoList),
  );

  if (!nodeInfoList) {
    return null;
  }

  const nodeInfoHref = nodeInfoList.links.find((link) =>
    link.rel.startsWith("http://nodeinfo.diaspora.software/ns/schema/2."),
  )?.href;

  if (!nodeInfoHref) {
    return null;
  }

  const nodeInfoValidator = z.object({
    software: z.object({
      name: z.string(),
      version: z.string(),
    }),
  });
  const nodeInfo = await axios
    .get(nodeInfoHref, {
      timeout: 5000,
      headers: {
        Accept: "application/json",
      },
    })
    .then((res) => res.data)
    .then(nodeInfoValidator.parseAsync)
    .catch(() => null);

  logger.debug(`Got node info from ${nodeInfoHref}`, JSON.stringify(nodeInfo));

  return nodeInfo;
};

const handleActivityPub: RequestHandler = async (req, res, url) => {
  const logger = req.$logger.subTagged("activity-pub");

  const instanceHandlers = {
    mastodon: () => handleMastodonToot(req, res, url),
    misskey: () => handleMisskeyPost(req, res, url),
    sharkey: () => handleMisskeyPost(req, res, url),
  };

  if (!req.$seenUrls) {
    req.$seenUrls = [];
  }

  if (req.$seenUrls.length > 5 || req.$seenUrls.includes(url.toString())) {
    return res
      .status(StatusCodes.IM_A_TEAPOT)
      .send(
        `Detected a loop in post URLs (${req.$seenUrls.join(
          " -> ",
        )}). Aborting.`,
      )
      .end();
  }

  const nodeInfo = await getNodeInfo(url, logger);
  if (!nodeInfo) {
    return res
      .status(StatusCodes.NOT_FOUND)
      .send("Could not get node info from the server")
      .end();
  }

  const softwareName = nodeInfo.software.name as
    | keyof typeof instanceHandlers
    | (string & {});

  logger.debug("Getting", softwareName, "instance handler");
  const handler =
    instanceHandlers[softwareName as keyof typeof instanceHandlers];

  if (!handler) {
    return res
      .status(StatusCodes.UNPROCESSABLE_ENTITY)
      .send(
        `Don't know how to handle ${JSON.stringify(softwareName)} instances`,
      )
      .end();
  }

  req.$seenUrls.push(url.toString());

  return handler();
};

const BLOCKED_BSKY_URLS = [
  "https://events.bsky.app/v2/rgstr",
  "https://statsigapi.net/v1/sdk_exception",
  "https://events.bsky.app/v2/initialize",
];
const handleBskyPost: RequestHandler = async (req, res, url) => {
  const logger = req.$logger.subTagged("bsky");
  logger.debug("BlueSky post URL", url.toString());

  const matcher =
    /^\/profile\/(?<username>[^/]+)\/post\/(?<postId>[a-zA-Z0-9]+)/;

  const match = matcher.exec(url.pathname);

  const username = match?.groups?.username;
  const postId = match?.groups?.postId;

  if (!match || !username || !postId) {
    logger.debug("Invalid BlueSky post URL", url.toString());
    return res
      .status(StatusCodes.UNPROCESSABLE_ENTITY)
      .send(
        "Invalid BlueSky post URL. Should look something like https://bsky.app/profile/some.username/post/randomP0stId",
      )
      .end();
  }

  logger.setTags({ bsky: `${postId}@${username}` });

  logger.debug(
    "Got BlueSky post request",
    JSON.stringify({ username, postId }),
  );

  const info = await BSKY_AGENT.app.bsky.feed
    .getPostThread({
      uri: `at://${username}/app.bsky.feed.post/${postId}`,
    })
    .catch((e) => {
      logger.debug("Error getting post", e);
      return null;
    });

  if (!info || !info.data) {
    return res
      .status(StatusCodes.NOT_FOUND)
      .send("Could not get post from the API")
      .end();
  }

  const post = info.data.thread.post as PostView | null | undefined;

  if (!post) {
    return res
      .status(StatusCodes.NOT_FOUND)
      .send("Could not get post info from the API response")
      .end();
  }

  const context = await newBrowserContext({
    storageState: {
      cookies: [],
      origins: [
        {
          origin: url.origin,
          localStorage: [
            BSKY_SESSION_DATA
              ? {
                  name: "BSKY_STORAGE",
                  value: BSKY_SESSION_DATA,
                }
              : undefined,
          ].filter(Boolean),
        },
      ],
    },
  });
  req.$browserContext = context;

  const buffer = await (async (context, url) => {
    logger.debug("Start rendering Bluesky page", url.toString());
    const page = await context.newPage();

    await page.route("**/*", (route) => {
      const url = route.request().url();

      if (BLOCKED_BSKY_URLS.includes(url)) {
        return route.abort("blockedbyclient");
      }

      return route.continue();
    });

    await page.goto(url.toString());

    if (BSKY_SESSION_DATA) {
      logger.debug("Embedding Bluesky session data");

      const shouldReload = await page.evaluate((data) => {
        const PARSED_BSKY_SESSION_DATA = JSON.parse(data);
        // @ts-ignore
        const newDid = PARSED_BSKY_SESSION_DATA?.session?.currentAccount?.did;

        let prevData = null;
        try {
          prevData = JSON.parse(
            window.localStorage.getItem("BSKY_STORAGE") ?? "{}",
          );
        } catch (_e) {}
        // @ts-ignore
        const prevDid = prevData?.session?.currentAccount?.did;

        if (prevDid === newDid) {
          return false;
        }

        window.localStorage.setItem("BSKY_STORAGE", data);
        return true;
      }, BSKY_SESSION_DATA);

      if (shouldReload) {
        logger.debug("Bluesky data updated. Reloading page...");
        await page.reload();
      } else {
        logger.debug("Bluesky data already up to date.");
      }
    }

    const postSelector = `[data-testid="postThreadItem-by-${username}"]`;

    logger.debug("Waiting for page to load");
    await page.waitForSelector(postSelector);
    logger.debug("Page loaded. Processing post.");

    const post$ = await page.$(postSelector).catch(() => null);

    if (!post$) {
      logger.debug("Bluesky post not available");
      return null;
    }

    // Remove post actions (eg. Like, Retweet, Reply, etc.)
    {
      await post$.evaluate(($el) => {
        // Remove duplicate info toolbar
        {
          let $actionsContainer = $el.querySelector(
            '[data-testid="replyBtn"]',
          )?.parentElement;
          while ($actionsContainer) {
            if ($actionsContainer.childElementCount > 1) {
              break;
            }
            $actionsContainer = $actionsContainer.parentElement;
          }

          $actionsContainer?.parentElement?.remove();
        }

        // Remove follow button
        {
          $el.querySelector('[data-testid="followBtn"]')?.remove();
        }

        // Remove who can reply bit
        {
          $el.querySelector('[aria-label="Who can reply"]')?.remove();
        }

        // Remove bottom border + padding
        {
          $el.style.marginBottom = "1rem";

          let $lastEl = $el.lastChild as HTMLElement | null | undefined;

          if ($lastEl) {
            $lastEl.style.paddingBottom = "0";
          }

          $lastEl = $lastEl?.lastChild as HTMLElement | null | undefined;

          if ($lastEl) {
            $lastEl.style.borderBottom = "0";
          }
        }
      });
    }

    logger.debug("Waiting for page to finish loading assets");
    await page.waitForLoadState("networkidle");

    logger.debug("Taking screenshot...");
    return post$.screenshot(SCREENSHOT_CONFIG);
  })(context, url).catch((e) => {
    logger.debug("Error taking screenshot", e);
    return null;
  });

  logger.debug("Screenshot taken", Boolean(buffer));

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
  res.setHeader(
    "Content-Disposition",
    `inline; filename="bluesky-post.${username.replaceAll(
      ".",
      "_",
    )}.${postId}.${SCREENSHOT_CONFIG.type}"`,
  );

  return res.end(buffer);
};

async function main() {
  if (IS_DEV) {
    console.clear();
  }

  BROWSER = await BrowserInstance.launch();

  {
    const bskyCredentialStore = new CredentialSession(
      new URL(process.env.BSKY_SERVICE_URL ?? "https://bsky.social"),
    );

    BSKY_AGENT = new Agent(bskyCredentialStore);
    {
      const refreshJwt = process.env.BSKY_REFRESH_TOKEN;
      const accIdentifier = process.env.BSKY_ACCOUNT_IDENTIFIER;
      const accPassword = process.env.BSKY_ACCOUNT_PASSWORD;

      if (accIdentifier && accPassword) {
        globalLogger.info("Logging into BSKY using credentials");
        globalLogger.debug("Using BSKY credentials", {
          accIdentifier,
          accPassword,
        });

        await bskyCredentialStore
          .login({
            identifier: accIdentifier,
            password: accPassword,
          })
          .catch((e) => {
            console.error("Error logging into bsky", e);
          });
      } else if (refreshJwt) {
        globalLogger.info("Logging into BSKY using refresh token");
        globalLogger.debug("Using BSKY credentials", {
          refreshJwt,
        });

        bskyCredentialStore.session = {
          refreshJwt,
          active: true,
        } as unknown as AtpSessionData;

        await bskyCredentialStore.refreshSession();
      }

      const session = bskyCredentialStore.session;

      if (session) {
        globalLogger.info("Successfully logged in to BSKY", {
          email: session.email,
          handle: session.handle,
          status: session.status,
        });

        const updateBskySessionData = () => {
          {
            const session = bskyCredentialStore.session;

            if (!session) {
              return;
            }

            const account = {
              accessJwt: session.accessJwt,
              active: true,
              did: session.did,
              email: session.email,
              emailAuthFactor: session.emailAuthFactor,
              emailConfirmed: session.emailConfirmed,
              handle: session.handle,
              pdsUrl: bskyCredentialStore.pdsUrl?.toString(),
              refreshJwt: session.refreshJwt,
              service: bskyCredentialStore.serviceUrl.toString(),
              signupQueued: false,
              isSelfHosted: false,
            };

            BSKY_SESSION_DATA = JSON.stringify({
              colorMode: "system",
              reminders: {
                lastEmailConfirm: new Date().toISOString(),
              },
              languagePrefs: {
                primaryLanguage: "en",
                contentLanguages: ["en", "hr"],
                postLanguage: "en",
                postLanguageHistory: ["en", "hr", "ja", "pt", "de"],
                appLanguage: "en",
              },
              requireAltTextEnabled: false,
              mutedThreads: [],
              invites: { copiedInvites: [] },
              onboarding: { step: "Home" },
              hiddenPosts: [],
              hasCheckedForStarterPack: true,
              lastSelectedHomeFeed:
                "feedgen|at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot",
              session: {
                accounts: [account],
                currentAccount: account,
              },
            });
          }
        };

        updateBskySessionData();

        setInterval(
          async () => {
            globalLogger.info("Refreshing BSKY credentials");
            await bskyCredentialStore.refreshSession();
            updateBskySessionData();
          },
          1000 * 60 * 60,
        );
      }
    }
  }

  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", Number(process.env.TRUST_PROXY ?? "2"));

  app.use((rawReq, res, next) => {
    const req = rawReq as AppRequest;

    req.$id = `${Date.now().toString(36)}${Math.random().toString(36)}`;
    req.$logger = globalLogger.subTagged({
      $id: req.$id,
    });
    res.setHeader("x-twitshot-request-id", req.$id);
    next();
  });

  app.use(morgan("combined"));

  app.use(bodyParserUrlencoded());

  const slowDownOptions = {
    windowMs: REQUESTS_MEASURE_WINDOW_SECONDS * 1000,
    delayAfter: REQUESTS_PER_SECOND * REQUESTS_MEASURE_WINDOW_SECONDS,
    delayMs(used) {
      const delayMs = 734;

      return (used - (this.delayAfter as number)) * delayMs;
    },
  } as Partial<SlowDownOptions>;

  if (
    process.env.REDIS_URL &&
    String(process.env.REDIS_URL).trim().length > 0
  ) {
    globalLogger.debug("Connecting to redis at", process.env.REDIS_URL);
    const client = createClient({
      url: process.env.REDIS_URL,
    });
    await client.connect();
    globalLogger.info("Connected to redis at", process.env.REDIS_URL);
    slowDownOptions.store = new RedisStore({
      sendCommand: (...args) => client.sendCommand(args),
    });
  }

  const speedLimiter = slowDown(slowDownOptions);

  app.get("/", (_req, res) => {
    res.set("Content-Type", "text/html; charset=utf-8").end(INDEX_HTML);
  });

  app.get("/favicon.ico", (_req, res) => {
    res.end(FAVICON_BLOB);
  });

  app.post("/", (req, res) => {
    if (!req.body || !req.body.url) {
      return res.sendStatus(StatusCodes.UNSUPPORTED_MEDIA_TYPE);
    }

    res.redirect(`/${req.body.url}`);
  });

  app.get("/healthz", (_req, res) => {
    return res.sendStatus(StatusCodes.OK);
  });

  app.get(
    "/*",
    speedLimiter,
    (rreq, _res, next) => {
      const req = rreq as AppRequest;
      req.$logger.info("Got request to render", req.params[0]);
      return next();
    },
    asyncReq(
      async (req, res) => {
        if (req.slowDown) {
          res.setHeader("x-ratelimit-limit", req.slowDown.limit.toString());
          res.setHeader("x-ratelimit-used", req.slowDown.used.toString());
          if (req.slowDown.resetTime) {
            res.setHeader(
              "x-ratelimit-reset",
              req.slowDown.resetTime.toISOString(),
            );
          }
        }

        let parsedUrl = null as URL | null;
        {
          const twitterUrl = req.params[0];
          try {
            req.$logger.debug("Starting processing", twitterUrl);

            if (twitterUrl) {
              parsedUrl = new URL(twitterUrl);
            }
          } catch (e) {
            req.$logger.debug("URL parse failed", twitterUrl, e);
          }
        }

        if (!parsedUrl) {
          return res.sendStatus(StatusCodes.BAD_REQUEST);
        }

        switch (parsedUrl.hostname) {
          case "twitter.com":
          case "x.com":
          case "www.x.com":
          case "www.twitter.com": {
            parsedUrl.hostname = "x.com";
            parsedUrl.protocol = "https:";

            return handleTwitterTweet(req, res, parsedUrl);
          }

          case "tumblr.com":
          case "www.tumblr.com": {
            parsedUrl.hostname = "www.tumblr.com";
            parsedUrl.protocol = "https:";

            return handleTumblrPost(req, res, parsedUrl);
          }

          case "bsky.app": {
            parsedUrl.hostname = "bsky.app";
            parsedUrl.protocol = "https:";

            return handleBskyPost(req, res, parsedUrl);
          }

          default: {
            const tumblrSubdomainPost = parsedUrl
              .toString()
              .match(
                /^https?:\/\/(?<subdomain>[^\-][a-zA-Z0-9\-]{0,30}[^\-])\.tumblr\.com\/post\/(?<postId>[\d]+)(?:\/(?<postSlug>[^\/]+))?/i,
              )?.groups;
            if (tumblrSubdomainPost) {
              parsedUrl.hostname = "www.tumblr.com";
              parsedUrl.protocol = "https:";
              parsedUrl.pathname = `/${tumblrSubdomainPost.subdomain}/${tumblrSubdomainPost.postId}`;
              if (tumblrSubdomainPost.postSlug) {
                parsedUrl.pathname += `/${tumblrSubdomainPost.postSlug}`;
              }

              return handleTumblrPost(req, res, parsedUrl);
            }

            return handleActivityPub(req, res, parsedUrl);
          }
        }
      },
      (req) => {
        req.$logger.info("Done with rendering", req.params[0]);
      },
    ),
  );

  app.listen(PORT, HOST, () => {
    globalLogger.info("Environment:", JSON.stringify(process.env));
    globalLogger.info(`Listening on http://${HOST}:${PORT}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
