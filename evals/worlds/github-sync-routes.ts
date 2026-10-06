import { createHmac, randomUUID } from "node:crypto";
import { denFetch, type DenFetchResult, type DenSession } from "@openwork/behaviors";
import type { Den, Seed } from "@openwork/env";

// GitHub sync lets an organization keep plugins in step with a GitHub
// repository: an admin connects a GitHub App installation, points a connector
// at a repository branch, and GitHub's push webhooks queue sync work.
//
// This world boots Den with a GitHub webhook secret but no GitHub App
// credentials, so nothing ever reaches GitHub. An admin and a member are
// signed in. The spec drives the public routes the dashboard and GitHub use,
// which is what has to keep behaving the same while the code behind them moves.

const WEBHOOK_SECRET = "eval-github-webhook-secret-not-a-real-secret";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export interface GithubSyncRoutesWorld {
  den: Den;
  admin: DenSession;
  member: DenSession;
  /** A GitHub App installation id no real GitHub knows about. */
  installationId: number;
  repositoryFullName: string;
  /** Calls a Den route as one person in the test organization. */
  call(session: DenSession, path: string, init?: RequestInit): Promise<DenFetchResult>;
  /** Delivers a GitHub webhook the way GitHub does, signed with the configured secret unless `signed` is false. */
  deliverWebhook(event: string, payload: Record<string, unknown>, options?: { signed?: boolean }): Promise<DenFetchResult & { deliveryId: string }>;
}

export const listItems = (body: unknown) => records(isRecord(body) ? body.items : null);

export async function githubSyncRoutes(seed: Seed): Promise<GithubSyncRoutesWorld> {
  const runId = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const orgName = `GitHub sync parity ${runId}`;
  const den = await seed.den({
    env: {
      GITHUB_CONNECTOR_APP_WEBHOOK_SECRET: WEBHOOK_SECRET,
      // No GitHub App: install and sync must fail closed without calling GitHub.
      GITHUB_CONNECTOR_APP_ID: undefined,
      GITHUB_CONNECTOR_APP_CLIENT_ID: undefined,
      GITHUB_CONNECTOR_APP_CLIENT_SECRET: undefined,
      GITHUB_CONNECTOR_APP_PRIVATE_KEY: undefined,
    },
    org: { name: orgName, members: { member: {} } },
  });
  const member = den.members.member;
  if (!member) throw new Error("The member was not provisioned");

  const orgs = await denFetch(den.admin, "/v1/me/orgs", { headers: { authorization: `Bearer ${den.admin.token}` } });
  const orgId = records(isRecord(orgs.body) ? orgs.body.orgs : null).find((org) => org.name === orgName)?.id;
  if (typeof orgId !== "string") throw new Error(`Test organization not found: HTTP ${orgs.response.status}`);

  const call = async (session: DenSession, path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${session.token}`);
    headers.set("x-openwork-org-id", orgId);
    return denFetch(session, path, { ...init, headers });
  };

  const deliverWebhook: GithubSyncRoutesWorld["deliverWebhook"] = async (event, payload, options = {}) => {
    const rawBody = JSON.stringify(payload);
    const deliveryId = randomUUID();
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": deliveryId,
    };
    if (options.signed !== false) {
      headers["x-hub-signature-256"] = `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex")}`;
    }
    const result = await denFetch(den.ref, "/v1/webhooks/connectors/github", { method: "POST", headers, body: rawBody });
    return { ...result, deliveryId };
  };

  return {
    den,
    admin: den.admin,
    member,
    installationId: 900_000_000 + Math.floor(Math.random() * 99_999_999),
    repositoryFullName: `eval-org/plugins-${runId}`,
    call,
    deliverWebhook,
  };
}
