import { StatusCodes } from "http-status-codes";
import type { BrowserContext } from "playwright";
import { BrowserInstance, newBrowserContext } from "~/services/browser";
import { Logger } from "~/services/logger";
import type { AppRequest, AppResponse } from "~/router";

export type RequestHandler = (
  req: AppRequest,
  res: AppResponse,
  url: URL,
) => unknown;

export const SEND_CACHE_HEADER_FOR_SECONDS = 15 * 60; // 15 minutes

export const SCREENSHOT_CONFIG = (() => {
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

export class ScreenshotResponseError extends Error {
  statusCode: number;
  body?: string;

  constructor(statusCode: number, body?: string) {
    super(body);
    this.statusCode = statusCode;
    this.body = body;
  }
}

export async function respondWithScreenshot({
  logger,
  createBrowserContext,
  url,
  req,
  res,
  handler,
  filenameFn,
  cacheForSecs = SEND_CACHE_HEADER_FOR_SECONDS,
}: {
  logger: Logger;
  createBrowserContext?: () => Promise<BrowserContext>;
  url: URL;
  req: AppRequest;
  res: AppResponse;
  handler: (
    context: BrowserContext,
    url: URL,
    logger: Logger,
  ) => Promise<Buffer | null | undefined>;
  filenameFn: () => string;
  cacheForSecs?: number;
}) {
  req.$browserContext = await (createBrowserContext ?? newBrowserContext)();
  const buffer = await handler(req.$browserContext, url, logger).catch((e) => {
    logger.debug("Error taking screenshot", String(e));
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
    `public, max-age=${cacheForSecs}, s-max-age=${cacheForSecs}`,
  );
  res.setHeader(
    "Content-Disposition",
    `inline; filename=${JSON.stringify(`${filenameFn()}.${SCREENSHOT_CONFIG.type}`)}`,
  );

  return res.end(buffer);
}
