import { randomBytes } from "node:crypto";
import { denFetch, signIn } from "@openwork/behaviors";
import type { DenRef, DenSession } from "@openwork/behaviors";
import { chrome, localHost } from "@openwork/hosts";
import { evaluateOnSurface } from "@openwork/cdp";
import {
  auth, createAgentMailInbox, createOrganization, deleteAgentMailInbox,
  deleteCreatedOrganization, requiredEnv, verificationCode, waitForAgentMailMessage,
} from "./live-den-api.ts";

export const liveBrowserNeeds = {
  optIn: ["OPENWORK_EVAL_LIVE"],
  env: ["OPENWORK_EVAL_LIVE_DEN_API_URL", "OPENWORK_EVAL_LIVE_DEN_WEB_URL", "AGENTMAIL_API_KEY"],
};

export function liveDen(): DenRef {
  const apiUrl = new URL(requiredEnv("OPENWORK_EVAL_LIVE_DEN_API_URL"));
  const webUrl = new URL(requiredEnv("OPENWORK_EVAL_LIVE_DEN_WEB_URL"));
  for (const url of [apiUrl, webUrl]) {
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("Live Den URLs must be HTTPS origins without credentials, paths, or query strings.");
    }
  }
  return { apiUrl: apiUrl.origin, webUrl: webUrl.origin };
}

export async function liveSignedOutBrowser() {
  const den = liveDen();
  const host = localHost();
  try {
    const web = await chrome({ host, headless: true, startUrl: den.webUrl });
    return {
      den, web,
      async location() {
        const value = await evaluateOnSurface(web, "location.href");
        if (typeof value !== "string") throw new Error("Browser location unavailable");
        return new URL(value);
      },
      async [Symbol.asyncDispose]() {
        try { await web.stop(); } finally { await host[Symbol.asyncDispose](); }
      },
    };
  } catch (error) {
    await host[Symbol.asyncDispose]();
    throw error;
  }
}

/** Owns only a unique mailbox, account, and explicitly created organization. */
export async function liveSignupBrowser() {
  const browser = await liveSignedOutBrowser();
  const mailKey = requiredEnv("AGENTMAIL_API_KEY");
  const run = `openwork-live-${Date.now()}-${randomBytes(4).toString("hex")}`;
  try {
    const inbox = await createAgentMailInbox(mailKey, run);
    let password = `Live!${randomBytes(20).toString("hex")}9`;
    let session: DenSession | undefined;
    let organizationId: string | undefined;
    let accountCreated = false;
    return {
      ...browser, inbox, run,
      get password() { return password; },
      set password(value: string) { password = value; },
      async mail(after: string, subject: RegExp) {
        return waitForAgentMailMessage(mailKey, inbox, after, "test account email", (message) => subject.test(message.subject));
      },
      async verify(after: string) {
        const message = await this.mail(after, /openwork verification code/i);
        return verificationCode(message);
      },
      async authenticate() {
        session = await signIn(browser.den, { email: inbox.email, password });
        accountCreated = true;
        return session;
      },
      async createWorkspace() {
        if (!session) throw new Error("Authenticate before creating the owned workspace");
        organizationId = await createOrganization(session, run);
        return organizationId;
      },
      async request(path: string, init: RequestInit = {}) {
        if (!session) throw new Error("Authenticate before reading owned data");
        return denFetch(session, path, { ...init, headers: { ...auth(session), ...init.headers } });
      },
      get organizationId() {
        if (!organizationId) throw new Error("No owned workspace");
        return organizationId;
      },
      async [Symbol.asyncDispose]() {
        const errors: unknown[] = [];
        if (session && organizationId) {
          try {
            // Password recovery can change credentials during a journey.
            await deleteCreatedOrganization({ ...session, password }, organizationId);
          } catch (error) { errors.push(error); }
        }
        try { await deleteAgentMailInbox(mailKey, inbox); } catch (error) { errors.push(error); }
        try { await browser[Symbol.asyncDispose](); } catch (error) { errors.push(error); }
        console.info(`[live-lane] run=${run} account=${accountCreated ? "retained (self-service deletion disabled)" : "may exist if signup was interrupted"} cleanupErrors=${errors.length}`);
        if (errors.length) throw new AggregateError(errors, `Owned resource cleanup failed for ${run}`);
      },
    };
  } catch (error) {
    await browser[Symbol.asyncDispose]();
    throw error;
  }
}

/** API arrangement only; all interactions under test use the real browser UI. */
export async function liveAccountBrowser() {
  const world = await liveSignupBrowser();
  try {
    const after = new Date().toISOString();
    const signup = await denFetch(world.den, "/api/auth/sign-up/email", {
      method: "POST", body: JSON.stringify({ email: world.inbox.email, password: world.password, name: "Live Eval" }),
    });
    if (!signup.response.ok) throw new Error(`Live signup arrangement: HTTP ${signup.response.status}`);
    const otp = await world.verify(after);
    const verified = await denFetch(world.den, "/api/auth/email-otp/verify-email", {
      method: "POST", body: JSON.stringify({ email: world.inbox.email, otp }),
    });
    if (!verified.response.ok) throw new Error(`Live verification arrangement: HTTP ${verified.response.status}`);
    await world.authenticate();
    await world.createWorkspace();
    return world;
  } catch (error) {
    await world[Symbol.asyncDispose]();
    throw error;
  }
}
