import { AppHandler } from "~/router";
import INDEX_HTML from "~/assets/index.html" with { type: "text" };
import { StatusCodes } from "http-status-codes";
import { handleTwitterTweet } from "./post/twitter";
import { handleTumblrPost } from "./post/tumblr";
import { handleBlueskyPost } from "./post/bluesky";
import { handleActivityPub } from "./post/activityPub";

export const handleScreenshotTweetHome: AppHandler = (_req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8").end(INDEX_HTML);
};

export const handleScreenshotTweetPost: AppHandler = (req, res) => {
  if (!req.body || !req.body.url) {
    return res.sendStatus(StatusCodes.UNSUPPORTED_MEDIA_TYPE);
  }

  res.redirect(`/${req.body.url}`);
};

export const handleScreenshotTweetProcess: AppHandler = async (req, res) => {
  if (req.slowDown) {
    res.setHeader("x-ratelimit-limit", req.slowDown.limit.toString());
    res.setHeader("x-ratelimit-used", req.slowDown.used.toString());
    if (req.slowDown.resetTime) {
      res.setHeader("x-ratelimit-reset", req.slowDown.resetTime.toISOString());
    }
  }

  let parsedUrl = null as URL | null;
  {
    const twitterUrl = req.params[0];
    try {
      req.$logger.debug("Starting processing", twitterUrl);

      if (twitterUrl) {
        parsedUrl = new URL(twitterUrl);
      }
    } catch (e) {
      req.$logger.debug(
        "URL parse failed",
        JSON.stringify(twitterUrl),
        String(e),
      );
    }
  }

  if (!parsedUrl) {
    return res.sendStatus(StatusCodes.BAD_REQUEST);
  }

  switch (parsedUrl.hostname) {
    case "twitter.com":
    case "x.com":
    case "www.x.com":
    case "www.twitter.com": {
      parsedUrl.hostname = "x.com";
      parsedUrl.protocol = "https:";

      return handleTwitterTweet(req, res, parsedUrl);
    }

    case "tumblr.com":
    case "www.tumblr.com": {
      parsedUrl.hostname = "www.tumblr.com";
      parsedUrl.protocol = "https:";

      return handleTumblrPost(req, res, parsedUrl);
    }

    case "bsky.app": {
      parsedUrl.hostname = "bsky.app";
      parsedUrl.protocol = "https:";

      return handleBlueskyPost(req, res, parsedUrl);
    }

    default: {
      const tumblrSubdomainPost = parsedUrl
        .toString()
        .match(
          /^https?:\/\/(?<subdomain>[^\-][a-zA-Z0-9\-]{0,30}[^\-])\.tumblr\.com\/post\/(?<postId>[\d]+)(?:\/(?<postSlug>[^\/]+))?/i,
        )?.groups;
      if (tumblrSubdomainPost) {
        parsedUrl.hostname = "www.tumblr.com";
        parsedUrl.protocol = "https:";
        parsedUrl.pathname = `/${tumblrSubdomainPost.subdomain}/${tumblrSubdomainPost.postId}`;
        if (tumblrSubdomainPost.postSlug) {
          parsedUrl.pathname += `/${tumblrSubdomainPost.postSlug}`;
        }

        return handleTumblrPost(req, res, parsedUrl);
      }

      return handleActivityPub(req, res, parsedUrl);
    }
  }
};
