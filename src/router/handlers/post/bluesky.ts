import { StatusCodes } from "http-status-codes";
import {
  respondWithScreenshot,
  SCREENSHOT_CONFIG,
  type RequestHandler,
} from "..";
import { BSKY_AGENT, BSKY_SESSION_DATA } from "~/services/bluesky";
import type { PostView } from "@atproto/api/dist/client/types/app/bsky/feed/defs";
import { newBrowserContext } from "~/services/browser";

const BLOCKED_BSKY_URLS = [
  "https://events.bsky.app/v2/rgstr",
  "https://statsigapi.net/v1/sdk_exception",
  "https://events.bsky.app/v2/initialize",
];
export const handleBlueskyPost: RequestHandler = async (req, res, url) => {
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

  return respondWithScreenshot({
    logger,
    req,
    res,
    url,
    createBrowserContext: () =>
      newBrowserContext({
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
      }),
    handler: async (context, url) => {
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

      logger.debug("Waiting for page to finish loading assets");
      await page.waitForLoadState("networkidle");

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

      logger.debug("Taking screenshot...");
      return post$.screenshot(SCREENSHOT_CONFIG);
    },
    filenameFn: () => `bluesky-post.${username.replaceAll(".", "_")}.${postId}`,
  });
};
