import { StatusCodes } from "http-status-codes";
import { RequestHandler, respondWithScreenshot, SCREENSHOT_CONFIG } from "..";

export const handleLinkedinPost: RequestHandler = (req, res, url) => {
  const logger = req.$logger.subTagged("linkedin");
  logger.debug("LinkedIn post URL", url.toString());

  const matcher = /^\/posts\/(?<username>[^_]+)_(?<slug>[^/]+)\/?/;

  const match = matcher.exec(url.pathname);

  const username = match?.groups?.username;
  const slug = match?.groups?.slug;

  if (!match || !username || !slug) {
    logger.debug("Invalid BlueSky post URL", url.toString());
    return res
      .status(StatusCodes.UNPROCESSABLE_ENTITY)
      .send(
        "Invalid LinkedIn post URL. Should look something like https://www.linkedin.com/posts/username_some-random-slug-in-url/",
      )
      .end();
  }

  logger.setTags({ linkedin: `${slug}@${username}` });

  logger.debug("Got LinkedIn post request", JSON.stringify({ username, slug }));

  return respondWithScreenshot({
    logger,
    req,
    res,
    url,
    handler: async (context, url) => {
      logger.debug("Start rendering LinkedIn page", url.toString());
      const page = await context.newPage();

      logger.debug("Navigate to LinkedIn post", url.toString());
      await page.goto(url.toString());

      logger.debug("Wait for page to fully load");
      await page.waitForLoadState("networkidle");

      const post$ = await page.$("article").catch((e) => {
        logger.warn("Error getting post", e);
        return null;
      });

      if (!post$) {
        logger.debug("Post not found");
        return null;
      }

      logger.debug("Got post");

      // Remove banners and overlays
      {
        await page
          .evaluate(() => {
            document.querySelector(".top-level-modal-container")?.remove();
            document.querySelector(".global-alert-banner")?.remove();
          })
          .catch(() => null);
      }

      // Expand post text
      {
        await post$
          .evaluate(($post) => {
            (
              $post.querySelector(
                'button[data-feed-action="see-more-post"]',
              ) as HTMLButtonElement | undefined
            )?.click();
          })
          .catch(() => null);
      }

      // Remove stuff after post metrics
      {
        await post$
          .evaluate(($post) => {
            let $el = $post.querySelector(
              ".main-feed-activity-card__social-actions",
            )?.nextSibling;

            while ($el) {
              const $nextEl = $el.nextSibling;
              $el.remove();
              $el = $nextEl;
            }
          })
          .catch(() => null);
      }

      // Remove ellipsis menu
      {
        await post$
          .evaluate(($post) => {
            $post
              .querySelector(".main-feed-activity-card__ellipsis-menu")
              ?.remove();
          })
          .catch(() => null);
      }

      // Remove video player play button
      {
        await post$
          .evaluate(($post) => {
            $post
              .querySelector('[aria-label="Video Player"] [title="Play Video"]')
              ?.remove();
          })
          .catch(() => null);
      }

      // Set font
      {
        await page.addStyleTag({
          content: `
          @import "https://fonts.googleapis.com/css2?family=Roboto:ital,wght@0,100..900;1,100..900&display=swap";

          body {
            font-family: "Roboto", sans-serif;
          }

          .font-sans {
            font-family: "Roboto", sans-serif !important;
          }
          `,
        });
        await page.evaluate(async () => {
          await document.fonts.ready;
        });
      }

      logger.debug("Screenshot post");

      return post$.screenshot(SCREENSHOT_CONFIG);
    },
    filenameFn: () => `linkedin.${username}.${slug}`,
  });
};
