import { StatusCodes } from "http-status-codes";
import { handleMisskeyPost } from "./activityPub/misskey";
import { Logger } from "~/services/logger";
import { z } from "zod";
import axios from "axios";
import { RequestHandler } from "..";
import { handleMastodonToot } from "./activityPub/mastodon";

export const handleActivityPub: RequestHandler = async (req, res, url) => {
  const logger = req.$logger.subTagged("activity-pub");

  const instanceHandlers = {
    mastodon: () => handleMastodonToot(req, res, url),
    misskey: () => handleMisskeyPost(req, res, url),
    sharkey: () => handleMisskeyPost(req, res, url),
  };

  if (!req.$seenUrls) {
    req.$seenUrls = [];
  }

  if (req.$seenUrls.length > 5 || req.$seenUrls.includes(url.toString())) {
    return res
      .status(StatusCodes.IM_A_TEAPOT)
      .send(
        `Detected a loop in post URLs (${req.$seenUrls.join(
          " -> ",
        )}). Aborting.`,
      )
      .end();
  }

  const nodeInfo = await getNodeInfo(url, logger);
  if (!nodeInfo) {
    return res
      .status(StatusCodes.NOT_FOUND)
      .send("Could not get node info from the server")
      .end();
  }

  const softwareName = nodeInfo.software.name as
    | keyof typeof instanceHandlers
    | (string & {});

  logger.debug("Getting", softwareName, "instance handler");
  const handler =
    instanceHandlers[softwareName as keyof typeof instanceHandlers];

  if (!handler) {
    return res
      .status(StatusCodes.UNPROCESSABLE_ENTITY)
      .send(
        `Don't know how to handle ${JSON.stringify(softwareName)} instances`,
      )
      .end();
  }

  req.$seenUrls.push(url.toString());

  return handler();
};

async function getNodeInfo(url: URL, logger: Logger) {
  const nodeInfoListValidator = z.object({
    links: z.array(
      z.object({
        rel: z.string(),
        href: z.string().url(),
      }),
    ),
  });

  const nodeInfoListUrl = `${url.protocol}//${url.hostname}/.well-known/nodeinfo`;
  const nodeInfoList = await axios
    .get(nodeInfoListUrl, {
      timeout: 5000,
      headers: {
        Accept: "application/json",
      },
    })
    .then((res) => res)
    .then((res) => res.data)
    .then(nodeInfoListValidator.parseAsync)
    .catch(() => null);

  logger.debug(
    `Got node info from ${nodeInfoListUrl}`,
    JSON.stringify(nodeInfoList),
  );

  if (!nodeInfoList) {
    return null;
  }

  const nodeInfoHref = nodeInfoList.links.find((link) =>
    link.rel.startsWith("http://nodeinfo.diaspora.software/ns/schema/2."),
  )?.href;

  if (!nodeInfoHref) {
    return null;
  }

  const nodeInfoValidator = z.object({
    software: z.object({
      name: z.string(),
      version: z.string(),
    }),
  });
  const nodeInfo = await axios
    .get(nodeInfoHref, {
      timeout: 5000,
      headers: {
        Accept: "application/json",
      },
    })
    .then((res) => res.data)
    .then(nodeInfoValidator.parseAsync)
    .catch(() => null);

  logger.debug(`Got node info from ${nodeInfoHref}`, JSON.stringify(nodeInfo));

  return nodeInfo;
}
