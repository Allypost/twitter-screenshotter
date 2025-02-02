import dns from "node:dns";
import type { AppHandler } from "~/router";
import INDEX_RAW_HTML_TEMPLATE from "~/assets/index-raw.html" with { type: "text" };
import {
  BROWSER_INFO,
  browserDimensions,
  newBrowserContext,
} from "~/services/browser";
import { StatusCodes } from "http-status-codes";
import { ElementHandle } from "playwright";
import {
  respondWithScreenshot,
  SCREENSHOT_CONFIG,
  ScreenshotResponseError,
} from ".";
import { BSKY_SESSION_DATA } from "~/services/bluesky";
import { BLOCKED_IPS_FILTER } from "~/services/ip-blocklist";

type ScreenshotOption = {
  title: string;
  description?: string;
  placeholder?: string;
} & (
  | {
      typeProps?: {
        type: "text";
      };
    }
  | {
      typeProps: {
        type: "number";
        min?: number;
        max?: number;
        step?: number;
      };
    }
);
const _screenshotOptions = <T extends Record<string, ScreenshotOption>>(x: T) =>
  x as {
    [K in keyof T]: ScreenshotOption;
  };
const screenshotOptions = _screenshotOptions({
  selectElement: {
    title: "Element to screenshot",
    description:
      "CSS selector for which element to screenshot. Will capture the entire element irregardless of page size.",
  },
  removeElements: {
    title: "Elements to remove",
    placeholder: "body > footer, #an-ad-banner, .my-annoying-element",
    description:
      "Comma-separated list of CSS selectors to remove from the page before taking the screenshot. Useful for removing annoying elements like login banners or simple ads.",
  },
  waitForElement: {
    title: "Wait for element to be present",
    description:
      "CSS selector which determines which element to wait for to be present on the page before taking the screenshot. Useful for SPAs where the page is loaded asynchronously.",
  },
  pageWidthPx: {
    title: "Page width",
    placeholder: BROWSER_INFO.width.toString(),
    description: "Width of the page in pixels.",
    typeProps: {
      type: "number",
      min: 100,
      max: 3000,
      step: 10,
    },
  },
  pageHeightPx: {
    title: "Page height",
    placeholder: BROWSER_INFO.height.toString(),
    description: "Height of the page in pixels.",
    typeProps: {
      type: "number",
      min: 100,
      max: 3000,
      step: 10,
    },
  },
  pageScaleFactor: {
    title: "Page scale factor",
    placeholder: "1.5",
    description:
      'Scale factor of the page from 0.5 to 3. Used to "zoom" the page which in practice means smaller or clearer screenshots.',
    typeProps: {
      type: "number",
      min: 0.5,
      max: 3,
      step: 0.5,
    },
  },
});

const INDEX_RAW_HTML = INDEX_RAW_HTML_TEMPLATE.replace(
  "{{{ELEMENT_INPUTS}}}",
  Object.entries(screenshotOptions)
    .map(([name, el]) =>
      `<p>
        <label>
          ${el.title}:
          <br>
          <input
            name="$$$$${name}"
            placeholder="${el.placeholder || "element#with-an-id.and-a-class-name"}"
            style="width: 100%"
            ${
              el.typeProps
                ? Object.entries(el.typeProps)
                    .filter(([_k, v]) => v !== undefined)
                    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
                    .join(" ")
                : ""
            }
            ${el.description ? `aria-describedby="_${name}-description"` : ""}
          >
        </label>
        ${el.description ? `<span id="_${name}-description" style="font-size: 0.75em; margin-top: 0.5em; opacity: 0.75">${el.description}</span>` : ""}
      </p>`.trim(),
    )
    .join("\n"),
);

export const handleScreenshotRawHome: AppHandler = (_req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8").end(INDEX_RAW_HTML);
};

export const handleScreenshotRawPost: AppHandler = (req, res) => {
  if (!req.body || !req.body.url) {
    return res.sendStatus(StatusCodes.UNSUPPORTED_MEDIA_TYPE);
  }

  const { url, ...queryParams } = req.body;

  try {
    new URL(req.body.url);
  } catch {
    return res.sendStatus(StatusCodes.BAD_REQUEST);
  }

  const urlParams = new URLSearchParams(
    Object.entries(queryParams).filter(([_k, v]) => Boolean(v)) as string[][],
  );

  res.redirect(`/http-raw/${req.body.url}?${urlParams.toString()}`);
};

export const handleScreenshotRawProcess: AppHandler = async (req, res) => {
  const logger = req.$logger.subTagged({ raw: null });
  if (req.slowDown) {
    res.setHeader("x-ratelimit-limit", req.slowDown.limit.toString());
    res.setHeader("x-ratelimit-used", req.slowDown.used.toString());
    if (req.slowDown.resetTime) {
      res.setHeader("x-ratelimit-reset", req.slowDown.resetTime.toISOString());
    }
  }

  const paramUrl = req.params[0];
  if (!paramUrl) {
    return res.sendStatus(StatusCodes.BAD_REQUEST);
  }

  const url = new URL(paramUrl);
  url.search = new URL(req.url, "http://localhost").search;
  for (const key of Array.from(url.searchParams.keys())) {
    if (key.startsWith("$$")) {
      url.searchParams.delete(key);
    }
  }
  logger.setTags({ raw: url.toString() });

  logger.debug("Raw URL", url.toString());

  const urlDomain = url.hostname;

  const resolveInfo = await new Promise<dns.LookupAddress[]>(
    (resolve, reject) =>
      dns.lookup(
        urlDomain,
        {
          all: true,
          verbatim: true,
          hints: dns.ADDRCONFIG | dns.V4MAPPED,
        },
        (err, data) => {
          if (err) {
            return reject(err);
          }

          resolve(data);
        },
      ),
  ).catch((e) => {
    logger.debug("DNS lookup failed", e);
    return null;
  });

  logger.debug("Resolved", urlDomain, "to", JSON.stringify(resolveInfo));

  if (!resolveInfo) {
    return res
      .status(StatusCodes.BAD_REQUEST)
      .send(`Could not resolve ${JSON.stringify(urlDomain)}`);
  }

  if (resolveInfo.some((x) => BLOCKED_IPS_FILTER.check(x.address))) {
    return res
      .status(StatusCodes.FORBIDDEN)
      .send(
        `Some domain IPs resolve to restricted IPs: ${resolveInfo.map((x) => x.address).join(", ")}`,
      );
  }

  const userScreenshotOptions = Object.entries(req.query)
    .map(([k, v]) => {
      if (k.startsWith("$$") && typeof v === "string") {
        return [k.slice(2), v] as const;
      }

      return null;
    })
    .filter(Boolean)
    .reduce(
      (acc, [k, v]) => {
        (acc as Record<string, string>)[k] = v;
        return acc;
      },
      {} as Readonly<{
        [K in keyof typeof screenshotOptions]?: string;
      }>,
    );

  return respondWithScreenshot({
    logger,
    req,
    res,
    url,
    cacheForSecs: 30 * 60, // 30 mins
    createBrowserContext: () => {
      const browserDims = browserDimensions({
        width: userScreenshotOptions.pageWidthPx,
        height: userScreenshotOptions.pageHeightPx,
        scaleFactor: userScreenshotOptions.pageScaleFactor || 1.5,
      });

      logger.debug("Using browser dimensions", JSON.stringify(browserDims));

      return newBrowserContext({
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
        ...browserDims,
      });
    },
    handler: async (context, url) => {
      logger.debug("Start rendering raw page", url.toString());
      const page = await context.newPage();

      await page.goto(url.toString());

      if (userScreenshotOptions.waitForElement) {
        logger.debug(
          "Waiting for element",
          userScreenshotOptions.waitForElement,
        );
        await page.waitForSelector(userScreenshotOptions.waitForElement);
      }
      logger.debug("Waiting for page to load");
      await page.waitForLoadState("networkidle");
      logger.debug("Page loaded. Processing page.");

      const removeSelectors = userScreenshotOptions.removeElements
        ?.split(",")
        .map((x) => x.trim());

      logger.debug("Removing elements...", JSON.stringify(removeSelectors));
      await page.evaluate((removeSelectors) => {
        if (!removeSelectors) {
          return;
        }

        for (const removeSelector of removeSelectors) {
          document
            .querySelectorAll(removeSelector.trim())
            .forEach((element) => {
              element.remove();
            });
        }
      }, removeSelectors);

      let elementToScreenshot = page as ElementHandle | typeof page;
      if (userScreenshotOptions.selectElement) {
        const element$ = await page.$(userScreenshotOptions.selectElement);

        if (!element$) {
          logger.debug("Element not found.");

          throw new ScreenshotResponseError(
            StatusCodes.NOT_FOUND,
            `Selected element not found: ${userScreenshotOptions.selectElement}`,
          );
        }

        elementToScreenshot = element$;
      }

      logger.debug("Taking screenshot...");
      return elementToScreenshot.screenshot(SCREENSHOT_CONFIG);
    },
    filenameFn: () =>
      `raw.${Buffer.from(url.origin).toString("base64url")}.${Date.now().toString(36)}`,
  });
};
