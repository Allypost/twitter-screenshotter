import { StatusCodes } from "http-status-codes";
import type { BrowserContext } from "playwright";
import { BrowserInstance, newBrowserContext } from "~/services/browser";
import type { Logger } from "~/services/logger";
import type { AppRequest, AppResponse } from "~/router";

export type Renderer = (
  context: BrowserContext,
  url: URL,
  logger: Logger,
) => Promise<Buffer | null | undefined>;
