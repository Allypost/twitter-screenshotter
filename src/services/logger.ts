export type LoggerTags = Record<string, string | null | undefined>;

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LOG_LEVELS_RANK = Object.fromEntries(
  LOG_LEVELS.map((level, i) => [level, i]),
) as Record<LogLevel, number>;

export class Logger {
  private logInstance = console.log;
  private tags: LoggerTags = {};
  private tagsStr = "";
  private logLevel: LogLevel;

  constructor(logLevel: LogLevel) {
    this.logLevel = logLevel;
  }

  setLogger(log: (...args: any[]) => any) {
    this.logInstance = log;
    return this;
  }

  #log(level: LogLevel, ...args: any[]) {
    const levelRank = LOG_LEVELS_RANK[level];
    if (levelRank < LOG_LEVELS_RANK[this.logLevel]) {
      return;
    }

    this.logInstance(
      `[${new Date().toISOString()}]`,
      `[${level}]`,
      this.tagsStr,
      ...args.map((arg) => arg),
    );
  }

  setTags(tags: LoggerTags | string) {
    if (typeof tags === "string") {
      tags = {
        [tags]: null,
      };
    }

    this.tags = { ...this.tags, ...tags };
    this.tagsStr = Object.entries(this.tags)
      .map(([key, value]) =>
        value !== null ? `[${key}=${JSON.stringify(value)}]` : `[${key}]`,
      )
      .join(" ");
    return this;
  }

  clearTags(...tags: (keyof LoggerTags)[]) {
    for (const tag of tags) {
      delete this.tags[tag];
    }
  }

  subTagged(tags: LoggerTags | string) {
    if (typeof tags === "string") {
      tags = {
        [tags]: null,
      };
    }

    return new Logger(this.logLevel)
      .setLogger(this.logInstance)
      .setTags({ ...this.tags, ...tags });
  }

  getTags() {
    return { ...this.tags };
  }

  trace(...args: any[]) {
    this.#log("trace", ...args);
  }

  debug(...args: any[]) {
    this.#log("debug", ...args);
  }

  info(...args: any[]) {
    this.#log("info", ...args);
  }

  warn(...args: any[]) {
    this.#log("warn", ...args);
  }

  error(...args: any[]) {
    this.#log("error", ...args);
  }
}
