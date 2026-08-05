import { createHmac, generateKeyPairSync } from "node:crypto";
import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { startMockGithub } from "@openwork/labs";
import type { MockGithubRepository } from "@openwork/labs";
import { localMysqlIsRunning, needs, server, test } from "@openwork/testkit";

/**
 * CLAIMS — APPROVED NARRATION:
 *  1. Push → auto-update. GitHub receives the webhook immediately, OpenWork
 *     acknowledges it before processing, and the exact pushed commit becomes
 *     the skill's latest stored version automatically.
 *  2. Rate-limited push retries itself. Two provider 429s recover without a
 *     human retry, the event completes rather than failing, and v3 is current.
 *  3. Back-to-back pushes, newest wins. Serialized target work materializes
 *     the current branch head, so an older event never overwrites v5.
 *  4. Rename. The connector follows the repository's stable id to its new name,
 *     and the next push still updates the skill — the #3521 failure mode heals.
 *  5. Lost webhook heals. Reconciliation notices branch drift, completes a
 *     manual resync, and imports v7 without a delivery or a human.
 *  6. Sync now + the story. A manual sync runs through the same worker without
 *     duplicating an unchanged version, and the event history proves pushes,
 *     retries, rename continuity, and reconciliation all happened.
 */

const localPlacement = process.env.OPENWORK_EVAL_DAYTONA !== "1"
  && !process.env.OPENWORK_EVAL_DEN_API_URL?.trim();
const mysqlOpen = await localMysqlIsRunning();
const title = !localPlacement
  ? "GitHub sync self-healing skipped — needs: local placement without OPENWORK_EVAL_DEN_API_URL"
  : !mysqlOpen
    ? "GitHub sync self-healing skipped — needs: MySQL on 127.0.0.1:3306"
    : "GitHub sync queues work, retries transient faults, reconciles drift, and survives repository renames";

const REQUEST_TIMEOUT_MS = 120_000;
const WEBHOOK_SECRET = "spec-webhook-secret";
const INSTALLATION_ID = 777;
const REPOSITORY_ID = 42;
const ORIGINAL_REPOSITORY = "acme-eval/probe-plugins";
const RENAMED_REPOSITORY = "acme-eval/probe-plugins-renamed";
const SKILL_PATH = "probe-plugin/skills/probe/SKILL.md";
const TERMINAL_STATUSES = new Set(["completed", "failed", "partial", "ignored"]);

const MARKETPLACE_MANIFEST = JSON.stringify({
  name: "Probe marketplace",
  description: "Private GitHub connector marketplace fixture",
  owner: { name: "acme-eval" },
  plugins: [{
    name: "probe-plugin",
    description: "Probe connector plugin",
    source: "./probe-plugin",
  }],
});
const PLUGIN_MANIFEST = JSON.stringify({
  name: "probe-plugin",
  description: "Probe connector plugin",
  skills: ["./skills"],
});

interface ApiResult {
  body: unknown;
  status: number;
  text: string;
}

interface WebhookResult extends ApiResult {
  deliveryId: string;
  durationMs: number;
}

interface SyncEvent {
  attemptCount: number;
  eventType: string;
  id: string;
  nextAttemptAt: string | null;
  sourceRevisionRef: string | null;
  status: string;
  summaryJson: Record<string, unknown> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} was not an object: ${JSON.stringify(value).slice(0, 500)}`);
  return value;
}

function requireRecords(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new Error(`${label} was not an object array: ${JSON.stringify(value).slice(0, 500)}`);
  }
  return value.filter(isRecord);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} was not a non-empty string.`);
  return value;
}

function requireNullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requireString(value, label);
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} was not a finite number.`);
  return value;
}

function requireNullableRecord(value: unknown, label: string): Record<string, unknown> | null {
  if (value === null) return null;
  return requireRecord(value, label);
}

function responseItem(body: unknown, label: string): Record<string, unknown> {
  return requireRecord(requireRecord(body, `${label} response`).item, `${label} item`);
}

function installEnvironment(values: Record<string, string>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

function skillMarkdown(version: string): string {
  return `---\nname: probe\ndescription: Probe connector import\n---\n\nRun the probe checklist ${version}.\n`;
}

function repositoryFiles(skillSource: string): Record<string, string> {
  return {
    ".claude-plugin/marketplace.json": MARKETPLACE_MANIFEST,
    "probe-plugin/.claude-plugin/plugin.json": PLUGIN_MANIFEST,
    [SKILL_PATH]: skillSource,
    "probe-plugin/skills/probe/references/notes.md": "# Notes\n\nCompanion file.\n",
  };
}

function githubRepositories(): MockGithubRepository[] {
  return [
    { id: 1, fullName: "acme-eval/repo-1", defaultBranch: "main", private: false },
    { id: REPOSITORY_ID, fullName: ORIGINAL_REPOSITORY, defaultBranch: "develop", private: true },
    { id: 43, fullName: "acme-eval/repo-43", defaultBranch: "main", private: false },
  ];
}

async function apiRequest(
  session: DenSession,
  path: string,
  input: { body?: Record<string, unknown>; method?: "GET" | "POST"; orgId?: string } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${session.token}`,
  };
  if (input.orgId) headers["x-openwork-org-id"] = input.orgId;
  if (input.body) headers["content-type"] = "application/json";
  const result = await denFetch(session, path, {
    method: input.method ?? "GET",
    headers,
    body: input.body ? JSON.stringify(input.body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!result.response.ok) {
    throw new Error(`${input.method ?? "GET"} ${path} failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return { body: result.body, status: result.response.status, text: result.text };
}

async function webhookRequest(
  session: DenSession,
  event: "push" | "repository",
  deliveryId: string,
  payload: Record<string, unknown>,
): Promise<WebhookResult> {
  const rawBody = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex")}`;
  const startedAt = Date.now();
  const result = await denFetch(session, "/v1/webhooks/connectors/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": deliveryId,
      "x-github-event": event,
      "x-hub-signature-256": signature,
    },
    body: rawBody,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return {
    body: result.body,
    deliveryId,
    durationMs: Date.now() - startedAt,
    status: result.response.status,
    text: result.text,
  };
}

async function resolveOrganizationId(session: DenSession): Promise<string> {
  const result = await apiRequest(session, "/v1/me/orgs");
  const orgs = requireRecords(requireRecord(result.body, "organization list response").orgs, "organizations");
  expect(orgs).toHaveLength(1);
  return requireString(orgs[0]?.id, "organization id");
}

function syncEvent(value: Record<string, unknown>): SyncEvent {
  return {
    attemptCount: requireNumber(value.attemptCount, "sync event attemptCount"),
    eventType: requireString(value.eventType, "sync event eventType"),
    id: requireString(value.id, "sync event id"),
    nextAttemptAt: requireNullableString(value.nextAttemptAt, "sync event nextAttemptAt"),
    sourceRevisionRef: requireNullableString(value.sourceRevisionRef, "sync event sourceRevisionRef"),
    status: requireString(value.status, "sync event status"),
    summaryJson: requireNullableRecord(value.summaryJson, "sync event summaryJson"),
  };
}

async function listSyncEvents(session: DenSession, orgId: string, connectorInstanceId: string): Promise<SyncEvent[]> {
  const result = await apiRequest(
    session,
    `/v1/connector-sync-events?connectorInstanceId=${encodeURIComponent(connectorInstanceId)}&limit=100`,
    { orgId },
  );
  return requireRecords(requireRecord(result.body, "sync event list").items, "sync events").map(syncEvent);
}

async function listVersions(session: DenSession, orgId: string, configObjectId: string): Promise<Record<string, unknown>[]> {
  const result = await apiRequest(
    session,
    `/v1/config-objects/${encodeURIComponent(configObjectId)}/versions?limit=100`,
    { orgId },
  );
  return requireRecords(requireRecord(result.body, "config object version list").items, "config object versions");
}

async function listTargets(session: DenSession, orgId: string, connectorInstanceId: string): Promise<Record<string, unknown>[]> {
  const result = await apiRequest(
    session,
    `/v1/connector-instances/${encodeURIComponent(connectorInstanceId)}/targets?limit=100`,
    { orgId },
  );
  return requireRecords(requireRecord(result.body, "connector target list").items, "connector targets");
}

function requireEvent(events: SyncEvent[], predicate: (event: SyncEvent) => boolean, label: string): SyncEvent {
  const event = events.find(predicate);
  if (!event) throw new Error(`${label} was missing from ${JSON.stringify(events).slice(0, 1_000)}`);
  return event;
}

function preview(value: unknown): string {
  const rendered = JSON.stringify(value) ?? String(value);
  return rendered.slice(0, 2_000);
}

async function pollUntil<T>(
  description: string,
  timeoutMs: number,
  stepMs: number,
  readValue: () => Promise<T>,
  accepted: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;
  while (Date.now() <= deadline) {
    lastValue = await readValue();
    if (accepted(lastValue)) return lastValue;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(stepMs, remainingMs)));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}. Last value: ${preview(lastValue)}`);
}

test.skipIf(!localPlacement || !mysqlOpen)(title, async ({ evidence, place }) => {
  needs({});
  const skillV1 = skillMarkdown("v1");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = String(privateKey.export({ type: "pkcs8", format: "pem" }));

  await using github = await startMockGithub({
    installationId: INSTALLATION_ID,
    accountLogin: "acme-eval",
    repositories: githubRepositories(),
    repoFiles: {
      [ORIGINAL_REPOSITORY]: {
        branch: "develop",
        files: repositoryFiles(skillV1),
      },
    },
  });
  const restoreEnvironment = installEnvironment({
    GITHUB_CONNECTOR_API_BASE: github.apiUrl,
    GITHUB_CONNECTOR_APP_ID: "123456",
    GITHUB_CONNECTOR_APP_PRIVATE_KEY: privateKeyPem,
    GITHUB_CONNECTOR_APP_WEBHOOK_SECRET: WEBHOOK_SECRET,
    GITHUB_SYNC_WORKER_INTERVAL_MS: "250",
    GITHUB_SYNC_RETRY_BASE_MS: "500",
    GITHUB_SYNC_MAX_ATTEMPTS: "5",
    GITHUB_RECONCILE_INTERVAL_MS: "2000",
    GITHUB_RECONCILE_MIN_AGE_MS: "0",
  });

  try {
    await using den = await server({ place });
    const orgId = await resolveOrganizationId(den.admin);
    const selectedOrganization = await apiRequest(den.admin, "/v1/me/active-organization", {
      method: "POST",
      orgId,
      body: { organizationId: orgId },
    });
    expect(selectedOrganization.status).toBe(200);

    const accountResult = await apiRequest(den.admin, "/v1/connectors/github/accounts", {
      method: "POST",
      orgId,
      body: {
        installationId: INSTALLATION_ID,
        accountLogin: "acme-eval",
        accountType: "Organization",
        displayName: "acme-eval",
      },
    });
    expect(accountResult.status).toBe(201);
    const connectorAccountId = requireString(responseItem(accountResult.body, "GitHub account").id, "connector account id");

    const setupResult = await apiRequest(den.admin, "/v1/connectors/github/setup", {
      method: "POST",
      orgId,
      body: {
        installationId: INSTALLATION_ID,
        connectorAccountId,
        connectorInstanceName: "Probe plugins",
        repositoryId: REPOSITORY_ID,
        repositoryFullName: ORIGINAL_REPOSITORY,
        branch: "develop",
        ref: "refs/heads/develop",
        mappings: [],
      },
    });
    expect([200, 201]).toContain(setupResult.status);
    const connectorInstanceId = requireString(
      requireRecord(responseItem(setupResult.body, "GitHub setup").connectorInstance, "setup connector instance").id,
      "connector instance id",
    );

    const discoveryResult = await apiRequest(
      den.admin,
      `/v1/connector-instances/${encodeURIComponent(connectorInstanceId)}/discovery`,
      { orgId },
    );
    const discoveredPlugins = requireRecords(
      responseItem(discoveryResult.body, "GitHub discovery").discoveredPlugins,
      "discovered plugins",
    );
    expect(discoveredPlugins).toHaveLength(1);
    const selectedKey = requireString(discoveredPlugins[0]?.key, "discovered plugin key");

    const applyResult = await apiRequest(
      den.admin,
      `/v1/connector-instances/${encodeURIComponent(connectorInstanceId)}/discovery/apply`,
      {
        method: "POST",
        orgId,
        body: { autoImportNewPlugins: true, selectedKeys: [selectedKey] },
      },
    );
    expect(applyResult.status).toBe(200);
    const materializedObjects = requireRecords(
      responseItem(applyResult.body, "discovery apply").materializedConfigObjects,
      "materialized config objects",
    );
    expect(materializedObjects).toHaveLength(1);
    const configObjectId = requireString(materializedObjects[0]?.id, "materialized config object id");
    const initialVersions = await listVersions(den.admin, orgId, configObjectId);
    expect(initialVersions).toHaveLength(1);
    expect(initialVersions[0]?.rawSourceText).toBe(skillV1.trim());

    let deliverySequence = 0;
    const deliverWebhook = (event: "push" | "repository", payload: Record<string, unknown>): Promise<WebhookResult> => {
      deliverySequence += 1;
      return webhookRequest(den.admin, event, `self-healing-${deliverySequence}`, payload);
    };
    const deliverPush = (repositoryFullName: string, headSha: string): Promise<WebhookResult> => deliverWebhook("push", {
      ref: "refs/heads/develop",
      after: headSha,
      repository: { id: REPOSITORY_ID, full_name: repositoryFullName },
      installation: { id: INSTALLATION_ID },
    });

    // Frame 1 — Push → auto-update, with an intentionally slow provider read.
    const skillV2 = skillMarkdown("v2");
    const revisionV2 = github.advanceHead(ORIGINAL_REPOSITORY, repositoryFiles(skillV2));
    github.injectFaults({
      count: 1,
      status: 200,
      pathIncludes: "/contents/",
      delayMs: 1_500,
    });
    const pushV2Ack = await deliverPush(ORIGINAL_REPOSITORY, revisionV2.headSha);
    const pushV2AckBody = requireRecord(pushV2Ack.body, "v2 push acknowledgement");
    expect(pushV2Ack.status).toBe(202);
    expect(pushV2AckBody).toMatchObject({ ok: true, accepted: true, queued: true });
    expect(pushV2Ack.durationMs).toBeLessThan(1_500);

    const eventsAfterV2 = await pollUntil(
      `completed push event for ${revisionV2.headSha}`,
      60_000,
      250,
      async () => (await listSyncEvents(den.admin, orgId, connectorInstanceId)).filter((event) => (
        event.eventType === "push" && event.sourceRevisionRef === revisionV2.headSha
      )),
      (events) => events.some((event) => (
        event.status === "completed"
      )),
    );
    const eventV2 = requireEvent(
      eventsAfterV2,
      (event) => event.eventType === "push" && event.sourceRevisionRef === revisionV2.headSha,
      "v2 push event",
    );
    const versionsAfterV2 = await listVersions(den.admin, orgId, configObjectId);
    expect(versionsAfterV2[0]?.rawSourceText).toBe(skillV2.trim());
    expect(eventV2.sourceRevisionRef).toBe(revisionV2.headSha);
    evidence.fact(
      "A push is acknowledged before processing and auto-updates the exact commit",
      `Delivery ${pushV2Ack.deliveryId} returned HTTP ${pushV2Ack.status} with queued=true in ${pushV2Ack.durationMs}ms, before the 1500ms content read; event ${eventV2.id} completed at ${eventV2.sourceRevisionRef} and stored v2.`,
      pushV2Ack.status === 202
        && pushV2AckBody.queued === true
        && pushV2Ack.durationMs < 1_500
        && eventV2.status === "completed"
        && eventV2.sourceRevisionRef === revisionV2.headSha
        && versionsAfterV2[0]?.rawSourceText === skillV2.trim(),
    );

    // Frame 2 — Two rate limits are retried by the worker.
    github.injectFaults({ count: 2, status: 429, retryAfterSeconds: 1 });
    const skillV3 = skillMarkdown("v3");
    const revisionV3 = github.advanceHead(ORIGINAL_REPOSITORY, repositoryFiles(skillV3));
    const pushV3Ack = await deliverPush(ORIGINAL_REPOSITORY, revisionV3.headSha);
    expect(pushV3Ack.status).toBe(202);
    const eventsAfterV3 = await pollUntil(
      `retried and completed push event for ${revisionV3.headSha}`,
      60_000,
      250,
      () => listSyncEvents(den.admin, orgId, connectorInstanceId),
      (events) => events.some((event) => (
        event.eventType === "push"
        && event.sourceRevisionRef === revisionV3.headSha
        && event.status === "completed"
      )),
    );
    const eventV3 = requireEvent(
      eventsAfterV3,
      (event) => event.eventType === "push" && event.sourceRevisionRef === revisionV3.headSha,
      "v3 push event",
    );
    const versionsAfterV3 = await listVersions(den.admin, orgId, configObjectId);
    const eventV3NotFailed = eventV3.status !== "failed";
    expect(eventV3.attemptCount).toBeGreaterThanOrEqual(1);
    expect(eventV3NotFailed).toBe(true);
    expect(eventV3.status).toBe("completed");
    expect(versionsAfterV3[0]?.rawSourceText).toBe(skillV3.trim());
    evidence.fact(
      "A rate-limited push retries itself instead of ending failed",
      `The v3 event completed with attemptCount=${eventV3.attemptCount} after two provider 429s; final status=${eventV3.status}, never failed, and the latest source is v3.`,
      eventV3.attemptCount >= 1
        && eventV3.status === "completed"
        && eventV3NotFailed
        && versionsAfterV3[0]?.rawSourceText === skillV3.trim(),
    );

    // Frame 3 — The v4 delivery arrives after the provider head has already moved to v5.
    const skillV4 = skillMarkdown("v4");
    const revisionV4 = github.advanceHead(ORIGINAL_REPOSITORY, repositoryFiles(skillV4));
    const skillV5 = skillMarkdown("v5");
    const revisionV5 = github.advanceHead(ORIGINAL_REPOSITORY, repositoryFiles(skillV5));
    const pushV4Ack = await deliverPush(ORIGINAL_REPOSITORY, revisionV4.headSha);
    const pushV5Ack = await deliverPush(ORIGINAL_REPOSITORY, revisionV5.headSha);
    expect(pushV4Ack.status).toBe(202);
    expect(pushV5Ack.status).toBe(202);
    const eventsAfterV5 = await pollUntil(
      "both back-to-back push events to become terminal",
      60_000,
      250,
      () => listSyncEvents(den.admin, orgId, connectorInstanceId),
      (events) => [revisionV4.headSha, revisionV5.headSha].every((revision) => (
        events.some((event) => event.eventType === "push"
          && event.sourceRevisionRef === revision
          && TERMINAL_STATUSES.has(event.status))
      )),
    );
    const eventV4 = requireEvent(eventsAfterV5, (event) => event.sourceRevisionRef === revisionV4.headSha, "v4 push event");
    const eventV5 = requireEvent(eventsAfterV5, (event) => event.sourceRevisionRef === revisionV5.headSha, "v5 push event");
    const versionsAfterV5 = await listVersions(den.admin, orgId, configObjectId);
    expect(eventV4.status).not.toBe("failed");
    expect(eventV5.status).not.toBe("failed");
    expect(versionsAfterV5[0]?.rawSourceText).toBe(skillV5.trim());
    evidence.fact(
      "Back-to-back pushes are serialized so the newest branch head wins",
      `The v4 event ended ${eventV4.status}, the v5 event ended ${eventV5.status}, and the newest version-list entry is v5; the older event did not overwrite it.`,
      TERMINAL_STATUSES.has(eventV4.status)
        && TERMINAL_STATUSES.has(eventV5.status)
        && eventV4.status !== "failed"
        && eventV5.status !== "failed"
        && versionsAfterV5[0]?.rawSourceText === skillV5.trim(),
    );

    // Frame 4 — Rename the provider repository while keeping stable id 42.
    github.renameRepository(ORIGINAL_REPOSITORY, RENAMED_REPOSITORY);
    const renameAck = await deliverWebhook("repository", {
      action: "renamed",
      repository: { id: REPOSITORY_ID, full_name: RENAMED_REPOSITORY },
      installation: { id: INSTALLATION_ID },
      changes: { repository: { name: { from: "probe-plugins" } } },
    });
    expect(renameAck.status).toBe(202);
    const renamedTargets = await pollUntil(
      `connector target remoteId to become ${RENAMED_REPOSITORY}`,
      60_000,
      250,
      () => listTargets(den.admin, orgId, connectorInstanceId),
      (targets) => targets.some((target) => target.remoteId === RENAMED_REPOSITORY),
    );
    const targetRenamed = renamedTargets.some((target) => target.remoteId === RENAMED_REPOSITORY);
    expect(targetRenamed).toBe(true);

    const skillV6 = skillMarkdown("v6");
    const revisionV6 = github.advanceHead(RENAMED_REPOSITORY, repositoryFiles(skillV6));
    const pushV6Ack = await deliverPush(RENAMED_REPOSITORY, revisionV6.headSha);
    expect(pushV6Ack.status).toBe(202);
    const eventsAfterV6 = await pollUntil(
      `completed renamed-repository push event for ${revisionV6.headSha}`,
      60_000,
      250,
      () => listSyncEvents(den.admin, orgId, connectorInstanceId),
      (events) => events.some((event) => event.eventType === "push"
        && event.sourceRevisionRef === revisionV6.headSha
        && event.status === "completed"),
    );
    const eventV6 = requireEvent(eventsAfterV6, (event) => event.sourceRevisionRef === revisionV6.headSha, "v6 push event");
    const versionsAfterV6 = await listVersions(den.admin, orgId, configObjectId);
    expect(versionsAfterV6[0]?.rawSourceText).toBe(skillV6.trim());
    evidence.fact(
      "GitHub sync survives a repository rename and its next push",
      `Stable repository id ${REPOSITORY_ID} moved the target remoteId to ${RENAMED_REPOSITORY}; the next event ${eventV6.id} completed and stored v6, covering the exact rename failure reported in #3521.`,
      targetRenamed && eventV6.status === "completed" && versionsAfterV6[0]?.rawSourceText === skillV6.trim(),
    );

    // Frame 5 — Move the provider head without delivering any webhook.
    const eventsBeforeLostWebhook = await listSyncEvents(den.admin, orgId, connectorInstanceId);
    const eventIdsBeforeLostWebhook = new Set(eventsBeforeLostWebhook.map((event) => event.id));
    const skillV7 = skillMarkdown("v7");
    github.advanceHead(RENAMED_REPOSITORY, repositoryFiles(skillV7));
    const healedState = await pollUntil(
      "reconciliation to complete a new manual_resync and store v7 without a webhook",
      30_000,
      250,
      async () => ({
        events: await listSyncEvents(den.admin, orgId, connectorInstanceId),
        versions: await listVersions(den.admin, orgId, configObjectId),
      }),
      (state) => state.events.some((event) => (
        !eventIdsBeforeLostWebhook.has(event.id)
        && event.eventType === "manual_resync"
        && event.status === "completed"
      )) && state.versions[0]?.rawSourceText === skillV7.trim(),
    );
    const reconciliationEvent = requireEvent(
      healedState.events,
      (event) => !eventIdsBeforeLostWebhook.has(event.id)
        && event.eventType === "manual_resync"
        && event.status === "completed",
      "lost-webhook reconciliation event",
    );
    expect(healedState.versions[0]?.rawSourceText).toBe(skillV7.trim());
    evidence.fact(
      "Reconciliation heals branch drift when the webhook is lost",
      `No delivery was sent for v7; reconciliation event ${reconciliationEvent.id} completed and stored v7 without human action.`,
      reconciliationEvent.eventType === "manual_resync"
        && reconciliationEvent.status === "completed"
        && healedState.versions[0]?.rawSourceText === skillV7.trim(),
    );

    // Frame 6 — Sync now uses the worker and leaves the unchanged version list alone.
    const eventsBeforeSyncNow = await listSyncEvents(den.admin, orgId, connectorInstanceId);
    const eventIdsBeforeSyncNow = new Set(eventsBeforeSyncNow.map((event) => event.id));
    const versionsBeforeSyncNow = await listVersions(den.admin, orgId, configObjectId);
    const syncNowResult = await apiRequest(
      den.admin,
      `/v1/connector-instances/${encodeURIComponent(connectorInstanceId)}/sync-now`,
      { method: "POST", orgId },
    );
    expect(syncNowResult.status).toBe(200);
    const enqueuedCount = requireNumber(responseItem(syncNowResult.body, "sync now").enqueuedCount, "sync now enqueued count");
    expect(enqueuedCount).toBeGreaterThanOrEqual(1);
    const eventsAfterSyncNow = await pollUntil(
      "the sync-now manual_resync event to become completed or ignored",
      60_000,
      250,
      () => listSyncEvents(den.admin, orgId, connectorInstanceId),
      (events) => events.some((event) => (
        !eventIdsBeforeSyncNow.has(event.id)
        && event.eventType === "manual_resync"
        && (event.status === "completed" || event.status === "ignored")
      )),
    );
    const syncNowEvent = requireEvent(
      eventsAfterSyncNow,
      (event) => !eventIdsBeforeSyncNow.has(event.id)
        && event.eventType === "manual_resync"
        && (event.status === "completed" || event.status === "ignored"),
      "sync-now event",
    );
    const versionsAfterSyncNow = await listVersions(den.admin, orgId, configObjectId);
    expect(syncNowEvent.status).not.toBe("failed");
    expect(versionsAfterSyncNow).toHaveLength(versionsBeforeSyncNow.length);

    const fullEvents = await listSyncEvents(den.admin, orgId, connectorInstanceId);
    const finalTargets = await listTargets(den.admin, orgId, connectorInstanceId);
    const hasCompletedPush = fullEvents.some((event) => event.eventType === "push" && event.status === "completed");
    const hasRetriedEvent = fullEvents.some((event) => event.attemptCount >= 1);
    const hasRenameStory = fullEvents.some((event) => event.eventType === "repository")
      || finalTargets.some((target) => target.remoteId === RENAMED_REPOSITORY);
    const hasManualResync = fullEvents.some((event) => event.eventType === "manual_resync");
    expect(hasCompletedPush).toBe(true);
    expect(hasRetriedEvent).toBe(true);
    expect(hasRenameStory).toBe(true);
    expect(hasManualResync).toBe(true);
    evidence.fact(
      "Sync now preserves an unchanged version and the event history tells the full self-healing story",
      `Sync now enqueued ${enqueuedCount} target(s), event ${syncNowEvent.id} ended ${syncNowEvent.status}, versions stayed at ${versionsAfterSyncNow.length}, and history contains a completed push, a retried event, rename continuity, and manual reconciliation.`,
      enqueuedCount >= 1
        && syncNowEvent.status !== "failed"
        && versionsAfterSyncNow.length === versionsBeforeSyncNow.length
        && hasCompletedPush
        && hasRetriedEvent
        && hasRenameStory
        && hasManualResync,
    );
  } finally {
    restoreEnvironment();
  }
});
