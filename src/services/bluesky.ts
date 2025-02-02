import { Agent, type AtpSessionData, CredentialSession } from "@atproto/api";
import { CONFIG } from "~/config";
import { Logger } from "~/services/logger";

export let BSKY_AGENT: Agent;
export let BSKY_SESSION_DATA: string | null = null;
const bskyCredentialStore = new CredentialSession(
  new URL(CONFIG.BSKY_SERVICE_URL),
);

export const BSKY_SESSION_REFRESH_INTERVAL_MS = 1000 * 60 * 60;

const updateBskySessionData = () => {
  const session = bskyCredentialStore.session;

  if (!session) {
    return;
  }

  const account = {
    accessJwt: session.accessJwt,
    active: true,
    did: session.did,
    email: session.email,
    emailAuthFactor: session.emailAuthFactor,
    emailConfirmed: session.emailConfirmed,
    handle: session.handle,
    pdsUrl: bskyCredentialStore.pdsUrl?.toString(),
    refreshJwt: session.refreshJwt,
    service: bskyCredentialStore.serviceUrl.toString(),
    signupQueued: false,
    isSelfHosted: false,
  };

  BSKY_SESSION_DATA = JSON.stringify({
    colorMode: "system",
    reminders: {
      lastEmailConfirm: new Date().toISOString(),
    },
    languagePrefs: {
      primaryLanguage: "en",
      contentLanguages: ["en", "hr"],
      postLanguage: "en",
      postLanguageHistory: ["en", "hr", "ja", "pt", "de"],
      appLanguage: "en",
    },
    requireAltTextEnabled: false,
    mutedThreads: [],
    invites: { copiedInvites: [] },
    onboarding: { step: "Home" },
    hiddenPosts: [],
    hasCheckedForStarterPack: true,
    lastSelectedHomeFeed:
      "feedgen|at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot",
    session: {
      accounts: [account],
      currentAccount: account,
    },
  });
};

export async function initBlueSky({ logger }: { logger: Logger }) {
  if (BSKY_AGENT) {
    return;
  }

  BSKY_AGENT = new Agent(bskyCredentialStore);

  const refreshJwt = CONFIG.BSKY_REFRESH_TOKEN;
  const accIdentifier = CONFIG.BSKY_ACCOUNT_IDENTIFIER;
  const accPassword = CONFIG.BSKY_ACCOUNT_PASSWORD;

  if (accIdentifier && accPassword) {
    logger.info("Logging into BSKY using credentials");
    logger.debug("Using BSKY credentials", {
      accIdentifier,
      accPassword,
    });

    await bskyCredentialStore
      .login({
        identifier: accIdentifier,
        password: accPassword,
      })
      .catch((e) => {
        logger.error("Error logging into bsky", e);
      });
  } else if (refreshJwt) {
    logger.info("Logging into BSKY using refresh token");
    logger.debug("Using BSKY credentials", {
      refreshJwt,
    });

    bskyCredentialStore.session = {
      refreshJwt,
      active: true,
    } as unknown as AtpSessionData;

    await bskyCredentialStore.refreshSession();
  }

  const session = bskyCredentialStore.session;

  if (session) {
    logger.info("Successfully logged in to BSKY", {
      email: session.email,
      handle: session.handle,
      status: session.status,
    });

    updateBskySessionData();

    setInterval(async () => {
      logger.info("Refreshing BSKY credentials");
      await bskyCredentialStore.refreshSession();
      updateBskySessionData();
    }, BSKY_SESSION_REFRESH_INTERVAL_MS);
  }
}
