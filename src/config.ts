import { z } from "zod";
import { LOG_LEVELS } from "./services/logger";

const envValidator = z.object({
  HOST: z.string().optional().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(0).max(65535).optional().default(8080),
  LOG_LEVEL: z.enum(LOG_LEVELS).optional().default("info"),
  TRUST_PROXY: z.coerce.number().int().min(0).optional().default(1),
  APPLICATION_INFO: z
    .string()
    .optional()
    .default("twitshot <https://github.com/allypost/twitter-screenshotter>"),
  ENABLE_RAW_SCREENSHOTS: z
    .string()
    .optional()
    .transform(
      (x) => !["false", "f", "0", "no"].includes(x?.toLowerCase() as never),
    ),
  NODE_ENV: z.string().optional().default("development"),

  REDIS_URL: z.string().url().optional(),

  BSKY_SERVICE_URL: z
    .string()
    .url()
    .optional()
    .default("https://public.api.bsky.app"),
  BSKY_ACCOUNT_IDENTIFIER: z.string().optional(),
  BSKY_ACCOUNT_PASSWORD: z.string().optional(),
  BSKY_REFRESH_TOKEN: z.string().optional(),
});

export type EnvConfig = z.infer<typeof envValidator>;

export const CONFIG = envValidator.parse(process.env);
