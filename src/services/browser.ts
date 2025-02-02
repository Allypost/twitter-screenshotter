import type { Browser, BrowserContextOptions } from "playwright";
import { CONFIG } from "../config";

import { firefox, devices } from "playwright";

export const BrowserInstance = firefox;
export const BrowserDevices = devices;

export const BROWSER_INFO = {
  width: 1152,
  height: 1536,
  scaleFactor: 2,
};

export let BROWSER: Browser;

export const initBrowser = async () => {
  BROWSER = await BrowserInstance.launch();
};

export const browserDimensions = ({
  width,
  height,
  scaleFactor,
}: {
  width?: string | number | null | undefined;
  height?: string | number | null | undefined;
  scaleFactor?: string | number | null | undefined;
} = {}) => {
  const clamp = (value: number, min: number, max: number) => {
    return Math.min(Math.max(value, min), max);
  };

  const s = clamp(Number(scaleFactor || BROWSER_INFO.scaleFactor), 0.5, 3);
  const w = clamp(Number(width || BROWSER_INFO.width), 100, 3000) * s;
  const h = clamp(Number(height || BROWSER_INFO.height), 100, 3000) * s;

  return {
    viewport: {
      width: w,
      height: h,
    },
    screen: {
      width: w,
      height: h,
    },
    deviceScaleFactor: s,
  } satisfies BrowserContextOptions;
};

export function newBrowserContext(options?: BrowserContextOptions) {
  return BROWSER.newContext({
    acceptDownloads: false,
    locale: "en-US",
    colorScheme: "dark",
    extraHTTPHeaders: {
      "x-application": CONFIG.APPLICATION_INFO,
      "x-is-twitshot": "true",
    },
    ...browserDimensions(),
    // reducedMotion: "reduce",
    ...options,
  }).then((ctx) => {
    ctx.setDefaultNavigationTimeout(35000);

    return ctx;
  });
}
