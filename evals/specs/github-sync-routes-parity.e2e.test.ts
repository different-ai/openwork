import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { githubSyncRoutes, listItems } from "../worlds/github-sync-routes.ts";

// Browser-less: GitHub sync is a set of Den routes the dashboard and GitHub's
// webhooks call. This journey pins what they answer, so moving the code behind
// them (W0-P03) can be checked against the same story.
const test = spec.world(githubSyncRoutes, {
  resources: { surfaces: [], services: ["den"] },
  timeout: 600_000,
});

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Reflect.get(value, key) : undefined;
}

function itemId(body: unknown): string {
  const id = field(field(body, "item"), "id");
  if (typeof id !== "string" || !id) throw new Error(`Expected an item id in ${JSON.stringify(body).slice(0, 300)}`);
  return id;
}

test("an admin connects a GitHub repository and GitHub's pushes queue sync work, while a member cannot connect GitHub", async ({ world, step, evidence }) => {
  const { admin, member, call, installationId, repositoryFullName } = world;

  await step("given: an organization with no GitHub connection yet", async () => {
    const accounts = await call(admin, "/v1/connector-accounts");
    const instances = await call(admin, "/v1/connector-instances");
    const ok = accounts.response.status === 200 && instances.response.status === 200
      && listItems(accounts.body).length === 0 && listItems(instances.body).length === 0;
    evidence.recordAssertionEvidence(
      "The admin sees no GitHub accounts or connectors",
      `connector accounts → HTTP ${accounts.response.status}, ${listItems(accounts.body).length} items; connectors → HTTP ${instances.response.status}, ${listItems(instances.body).length} items`,
      ok,
    );
    expect(ok).toBe(true);
  });

  await step("when: the admin starts installing the GitHub App on a Den with no App configured, Den says so", async () => {
    const started = await call(admin, "/v1/connectors/github/install/start", { method: "POST", body: JSON.stringify({ returnPath: "/dashboard/plugins" }) });
    const error = field(started.body, "error");
    evidence.recordAssertionEvidence(
      "Install start explains the missing GitHub App",
      `HTTP ${started.response.status}; error ${String(error)}; "${String(field(started.body, "message")).slice(0, 160)}"`,
      started.response.status === 409 && error === "github_connector_app_not_configured",
    );
    expect(started.response.status).toBe(409);
    expect(error).toBe("github_connector_app_not_configured");
  });

  await step("and: a member cannot start a GitHub install or add a GitHub account", async () => {
    const started = await call(member, "/v1/connectors/github/install/start", { method: "POST", body: JSON.stringify({ returnPath: "/dashboard/plugins" }) });
    const created = await call(member, "/v1/connector-accounts", {
      method: "POST",
      body: JSON.stringify({ connectorType: "github", remoteId: String(installationId + 1), displayName: "Member's GitHub" }),
    });
    const ok = started.response.status === 403 && created.response.status === 403
      && field(started.body, "error") === "forbidden" && field(created.body, "error") === "forbidden";
    evidence.recordAssertionEvidence(
      "Both are refused for the member",
      `install start → HTTP ${started.response.status} (${String(field(started.body, "message"))}); add account → HTTP ${created.response.status} (${String(field(created.body, "message"))})`,
      ok,
    );
    expect(ok).toBe(true);
  });

  let accountId = "";
  let instanceId = "";

  await step("when: the admin records a GitHub installation and points a connector at a repository branch", async () => {
    const account = await call(admin, "/v1/connector-accounts", {
      method: "POST",
      body: JSON.stringify({ connectorType: "github", remoteId: String(installationId), displayName: "Eval GitHub org" }),
    });
    accountId = account.response.status === 201 ? itemId(account.body) : "";
    const instance = await call(admin, "/v1/connector-instances", {
      method: "POST",
      body: JSON.stringify({ connectorAccountId: accountId, connectorType: "github", name: "Plugins repository", remoteId: repositoryFullName }),
    });
    instanceId = instance.response.status === 201 ? itemId(instance.body) : "";
    const target = await call(admin, `/v1/connector-instances/${encodeURIComponent(instanceId)}/targets`, {
      method: "POST",
      body: JSON.stringify({ connectorType: "github", remoteId: repositoryFullName, targetKind: "repository_branch", config: { ref: "refs/heads/main" } }),
    });
    const ok = account.response.status === 201 && instance.response.status === 201 && target.response.status === 201;
    evidence.recordAssertionEvidence(
      "Account, connector and branch target are created",
      `account → HTTP ${account.response.status}; connector → HTTP ${instance.response.status}; target ${repositoryFullName}@main → HTTP ${target.response.status}`,
      ok,
    );
    expect(ok).toBe(true);
  });

  await step("then: the member does not see the admin's connector", async () => {
    const adminView = await call(admin, "/v1/connector-instances");
    const memberView = await call(member, "/v1/connector-instances");
    const adminIds = listItems(adminView.body).map((item) => String(item.id));
    const memberIds = listItems(memberView.body).map((item) => String(item.id));
    const ok = adminIds.includes(instanceId) && memberView.response.status === 200 && !memberIds.includes(instanceId);
    evidence.recordAssertionEvidence(
      "Only the admin lists the connector",
      `admin → ${adminIds.length} connector(s), includes it: ${adminIds.includes(instanceId)}; member → HTTP ${memberView.response.status}, ${memberIds.length} connector(s)`,
      ok,
    );
    expect(ok).toBe(true);
  });

  await step("then: a webhook delivery without GitHub's signature is rejected", async () => {
    const delivered = await world.deliverWebhook("push", { installation: { id: installationId } }, { signed: false });
    evidence.recordAssertionEvidence(
      "Unsigned delivery refused",
      `HTTP ${delivered.response.status}; ${delivered.text.slice(0, 120)}`,
      delivered.response.status === 401,
    );
    expect(delivered.response.status).toBe(401);
  });

  const headSha = "0123456789abcdef0123456789abcdef01234567";
  const pushPayload = () => ({
    ref: "refs/heads/main",
    after: headSha,
    installation: { id: installationId },
    repository: { id: 4242, full_name: repositoryFullName },
  });

  await step("when: GitHub delivers a signed push to the connected branch, Den queues one sync for that connector", async () => {
    const delivered = await world.deliverWebhook("push", pushPayload());
    const events = await call(admin, `/v1/connector-sync-events?connectorInstanceId=${encodeURIComponent(instanceId)}`);
    const pushes = listItems(events.body).filter((event) => event.eventType === "push" && event.sourceRevisionRef === headSha);
    const ok = delivered.response.status === 202 && field(delivered.body, "queued") === true
      && pushes.length === 1 && pushes[0]?.externalEventRef === delivered.deliveryId;
    evidence.recordAssertionEvidence(
      "The push is accepted and recorded as sync work",
      `webhook → HTTP ${delivered.response.status} ${delivered.text.slice(0, 160)}; sync events for the connector: ${pushes.map((event) => `${String(event.eventType)} ${String(event.status)} @${String(event.sourceRevisionRef).slice(0, 7)}`).join(", ") || "none"}`,
      ok,
    );
    expect(ok).toBe(true);
  });

  await step("and: GitHub redelivering the same commit does not queue it twice", async () => {
    const delivered = await world.deliverWebhook("push", pushPayload());
    const events = await call(admin, `/v1/connector-sync-events?connectorInstanceId=${encodeURIComponent(instanceId)}`);
    const pushes = listItems(events.body).filter((event) => event.eventType === "push" && event.sourceRevisionRef === headSha);
    const ok = delivered.response.status === 200 && field(delivered.body, "accepted") === false && pushes.length === 1;
    evidence.recordAssertionEvidence(
      "Redelivery is ignored",
      `webhook → HTTP ${delivered.response.status} ${delivered.text.slice(0, 160)}; push events for ${headSha.slice(0, 7)}: ${pushes.length}`,
      ok,
    );
    expect(ok).toBe(true);
  });

  await step("after: uninstalling the GitHub App disconnects the organization's GitHub account", async () => {
    const delivered = await world.deliverWebhook("installation", { action: "deleted", installation: { id: installationId } });
    const account = await call(admin, `/v1/connector-accounts/${encodeURIComponent(accountId)}`);
    const status = field(field(account.body, "item"), "status");
    const ok = delivered.response.status === 202 && field(delivered.body, "queued") === false && status === "disconnected";
    evidence.recordAssertionEvidence(
      "The account is marked disconnected",
      `webhook → HTTP ${delivered.response.status} ${delivered.text.slice(0, 120)}; account status ${String(status)}`,
      ok,
    );
    expect(ok).toBe(true);
  });
});
