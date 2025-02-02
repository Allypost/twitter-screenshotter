import { CONFIG } from "./config";
import { initBrowser } from "./services/browser";
import { initBlueSky } from "./services/bluesky";
import { Logger } from "./services/logger";
import { createRouter } from "./router";
import { initRedis } from "./services/redis";
import { BLOCKED_IPS_FILTER } from "./services/ip-blocklist";

const logger = new Logger(CONFIG.LOG_LEVEL);

async function main() {
  if (CONFIG.NODE_ENV === "develpment") {
    console.clear();
  }

  await initRedis({
    logger,
  });
  await initBrowser();
  await initBlueSky({
    logger,
  });

  const app = await createRouter({
    logger,
  });

  const server = app.listen(CONFIG.PORT, CONFIG.HOST, () => {
    const listeningOn = (() => {
      const addr = server.address();
      if (addr === null) {
        return null;
      }

      if (typeof addr === "string") {
        return addr;
      }

      return `${addr.address}:${addr.port}`;
    })();

    logger.info("Environment:", JSON.stringify(process.env));
    logger.info("Config:", JSON.stringify(CONFIG));
    logger.info(`Blocked scrape IPs:`, BLOCKED_IPS_FILTER.rules.join(", "));
    logger.info(`Listening on http://${listeningOn}`);
  });
}

main().catch((e) => {
  logger.error(e);
  process.exit(1);
});
