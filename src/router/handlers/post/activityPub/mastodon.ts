import axios from "axios";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import {
  respondWithScreenshot,
  SCREENSHOT_CONFIG,
  type RequestHandler,
} from "~/router/handlers";
import { handleActivityPub } from "../activityPub";

export const handleMastodonToot: RequestHandler = async (req, res, url) => {
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

  return respondWithScreenshot({
    logger,
    req,
    res,
    url,
    handler: async (context, url) => {
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
        (await page.$(
          "#mastodon .scrollable:has(.detailed-status__wrapper)",
        )) ?? toot$;

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
            .querySelectorAll(
              ".status__action-bar, .detailed-status__action-bar",
            )
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
    },
    filenameFn: () => `toot.${url.hostname}.${tootId}`,
  });
};
