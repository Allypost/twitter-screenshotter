import {
  respondWithScreenshot,
  SCREENSHOT_CONFIG,
  type RequestHandler,
} from "..";

export const handleTumblrPost: RequestHandler = async (req, res, url) => {
  const logger = req.$logger.subTagged("tumblr");
  // /<user>/<post-id>(/<post-slug>)
  const [_constPostStr, postUser, postId] = url.pathname.split("/");

  logger.setTags({ tumblr: `${postId}@${postUser}` });
  logger.debug("Tumblr URL", url.toString());

  return respondWithScreenshot({
    logger,
    req,
    res,
    url,
    handler: async (context, url) => {
      logger.debug("Start rendering Tumblr page", url.toString());
      const page = await context.newPage();

      logger.debug("Navigate to Tumblr post", url.toString());
      await page.goto(url.toString());

      logger.debug("Wait for page to fully load");
      await page.waitForLoadState("networkidle");

      const post$ = await page
        .$(`*[data-id="${postId}"] article:has(header + div + div)`)
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
        const header$ = await post$
          .$('header[role="banner"]')
          .catch(() => null);

        if (header$) {
          await header$
            .evaluate(($header) => {
              $header.querySelector('[aria-label="More options"]')?.remove();
              $header.querySelector('[aria-label="Follow"]')?.remove();
            })
            .catch((e) => {
              logger.debug(
                'Remove three dots and "follow" from post header',
                e,
              );
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

                $pa
                  .querySelector('[role="tab"][title="Reblog Graph"]')
                  ?.remove();

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
            document
              .querySelector(".components-modal__screen-overlay")
              ?.remove();
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
    },
    filenameFn: () => `tumblr.${postUser}.${postId}`,
  });
};
