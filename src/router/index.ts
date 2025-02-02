import express from "express";
import type { Request, Response } from "express";
import { type Logger } from "../services/logger";
import slowDown from "express-slow-down";
import type {
  SlowDownInfo,
  Options as SlowDownOptions,
} from "express-slow-down";
import type { Browser, BrowserContext } from "playwright";
import { urlencoded as bodyParserUrlencoded } from "body-parser";
import RedisStore from "rate-limit-redis";
import { StatusCodes } from "http-status-codes";
import {
  handleScreenshotTweetHome,
  handleScreenshotTweetPost,
  handleScreenshotTweetProcess,
} from "./handlers/post";
import {
  handleScreenshotRawHome,
  handleScreenshotRawPost,
  handleScreenshotRawProcess,
} from "./handlers/raw";
import { REDIS_CLIENT } from "../services/redis";
import { CONFIG } from "../config";
import faviconPath from "~/assets/favicon.ico" with { type: "file" };

const FAVICON_BLOB = await Bun.file(faviconPath).bytes();

export type AppRequest = Request & {
  $browser: Browser;
  $browserContext: BrowserContext | null | undefined;
  $seenUrls: string[] | undefined;
  $logger: Logger;
  $id: string;
  slowDown?: SlowDownInfo;
};

export type AppResponse = Response;

const REQUESTS_PER_SECOND = 1;
const REQUESTS_MEASURE_WINDOW_SECONDS = 1 * 60; // 1 minute

export type AppHandler = (req: AppRequest, res: AppResponse) => any;

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

export async function createRouter({ logger }: { logger: Logger }) {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", CONFIG.TRUST_PROXY);
  app.use((rawReq, res, next) => {
    const req = rawReq as AppRequest;

    req.$id = `${Date.now().toString(36)}${Math.random().toString(36)}`;
    req.$logger = logger.subTagged({
      $id: req.$id,
    });
    res.setHeader("x-twitshot-request-id", req.$id);

    const info = {
      ip: req.ip,
      method: req.method,
      url: req.url,
      ua: req.headers["user-agent"],
      referer: req.headers.referer,
    };
    req.$logger.debug(`START`, ..._toReqLogLine(info));

    const start = process.hrtime.bigint();
    next();

    res.once("finish", () => {
      const end = process.hrtime.bigint();
      const duration_ms = Number((end - start) / BigInt(1e4)) / 1e2;
      req.$logger.info(
        `END`,
        ..._toReqLogLine({
          status: res.statusCode,
          took: duration_ms,
          ...info,
        }),
      );
    });
  });

  app.use(bodyParserUrlencoded());

  const slowDownOptions = {
    windowMs: REQUESTS_MEASURE_WINDOW_SECONDS * 1000,
    delayAfter: REQUESTS_PER_SECOND * REQUESTS_MEASURE_WINDOW_SECONDS,
    delayMs(used) {
      const delayMs = 734;

      return (used - (this.delayAfter as number)) * delayMs;
    },
  } as Partial<SlowDownOptions>;

  if (REDIS_CLIENT) {
    slowDownOptions.store = new RedisStore({
      sendCommand: (...args) => REDIS_CLIENT.sendCommand(args),
    });
  }

  const speedLimiter = slowDown(slowDownOptions);

  app.get("/healthz", (_req, res) => {
    return res.sendStatus(StatusCodes.OK);
  });
  app.get("/favicon.ico", (_req, res) => {
    res.setHeader("content-type", "image/x-icon").end(FAVICON_BLOB);
  });
  app.get("/robots.txt", (_req, res) => {
    res
      .setHeader("content-type", "text/plain")
      .end("User-agent: *\nDisallow: /");
  });

  if (CONFIG.ENABLE_RAW_SCREENSHOTS) {
    app.get("/raw", handleScreenshotRawHome as never);
    app.post("/raw", handleScreenshotRawPost as never);
    app.get(
      "/http-raw/*",
      speedLimiter,
      (rreq, _res, next) => {
        const req = rreq as AppRequest;
        req.$logger.info("Got request to render", req.params[0]);
        return next();
      },
      asyncReq(handleScreenshotRawProcess, (req) => {
        req.$logger.info("Done with rendering", req.params[0]);
      }),
    );
  }

  app.get("/", handleScreenshotTweetHome as never);
  app.post("/", handleScreenshotTweetPost as never);
  app.get(
    "/*",
    speedLimiter,
    (rreq, _res, next) => {
      const req = rreq as AppRequest;
      req.$logger.info("Got request to render", req.params[0]);
      return next();
    },
    asyncReq(handleScreenshotTweetProcess, (req) => {
      req.$logger.info("Done with rendering", req.params[0]);
    }),
  );

  return app;
}

function _toReqLogLine(
  info: Record<string, string | number | null | undefined>,
) {
  return Object.entries(info)
    .filter(([_k, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`);
}
