import {
  type RequestHandler,
  respondWithScreenshot,
  SCREENSHOT_CONFIG,
} from "~/router/handlers";

export const handleMisskeyPost: RequestHandler = async (req, res, url) => {
  const urlPath = url.pathname.replace(/\/$/, "");
  const postId = urlPath.split("/").pop() ?? "";

  const logger = req.$logger.subTagged({ misskey: url.toString() });
  logger.debug("Misskey post", url.toString());

  return respondWithScreenshot({
    logger,
    req,
    res,
    url,
    handler: async (context, url) => {
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
              $footer.parentElement?.querySelector("footer > button")
                ?.nextSibling?.nextSibling;
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
    },
    filenameFn: () => `misskey-post.${url.hostname}.${postId}`,
  });
};
