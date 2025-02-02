import { createClient } from "redis";
import { CONFIG } from "~/config";
import { Logger } from "~/services/logger";

export let REDIS_CLIENT: ReturnType<typeof createClient>;

export async function initRedis({ logger: logger }: { logger: Logger }) {
  if (REDIS_CLIENT) {
    return;
  }

  if (!CONFIG.REDIS_URL) {
    return;
  }

  logger.debug("Connecting to redis at", CONFIG.REDIS_URL);
  const client = createClient({
    url: CONFIG.REDIS_URL,
  });
  await client.connect();
  logger.info("Connected to redis at", CONFIG.REDIS_URL);

  REDIS_CLIENT = client;
}
