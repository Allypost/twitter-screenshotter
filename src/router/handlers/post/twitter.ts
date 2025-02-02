import https from "node:https";
import { StatusCodes } from "http-status-codes";
import type { Renderer } from ".";
import {
  type RequestHandler,
  respondWithScreenshot,
  SCREENSHOT_CONFIG,
} from "..";
import { BrowserDevices } from "~/services/browser";
import EMBED_HTML from "~/assets/embed.html" with { type: "text" };

export const renderTweetPage: Renderer = async (context, url, logger) => {
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

export const renderTweetEmbedded: Renderer = async (context, url, logger) => {
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

export const renderTweet: Renderer = (context, url, logger) =>
  renderTweetPage(context, url, logger).then(
    (data) => data || renderTweetEmbedded(context, url, logger),
  );

const BrowserInfo = BrowserDevices["Desktop Chrome"];

export const handleTwitterTweet: RequestHandler = async (req, res, url) => {
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

  return respondWithScreenshot({
    logger,
    req,
    res,
    url,
    handler: renderTweet,
    filenameFn: () => `tweet.${tweetId}`,
  });
};
