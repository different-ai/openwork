import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { CONFIG_AREA_KEYS, type ConfigAreaKey, type ConfigBlob, type ConfigChangeRequestSummary, type ConfigPlan, type ConfigPlanItem } from "@openwork/types/den/config-blobs";
import { BYOK_API_KEY, configBlobsCloudToSelfHostedWorld } from "../worlds/config-blobs-cloud-to-self-hosted.ts";

const test = spec.world(configBlobsCloudToSelfHostedWorld, {
  resources: { surfaces: ["web"], services: ["den", "mock"] },
  // Two local Dens (two databases, so two instance ids): one booted as OpenWork Cloud, one as self-hosted.
  needs: { placement: "local" },
  timeout: 900_000,
});

// ---------------------------------------------------------------------------
// Reading config blobs and plans from the public API.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asBlob(value: unknown): ConfigBlob {
  if (!isRecord(value) || value.format !== "openwork.config-blob") throw new Error(`Not a config blob: ${JSON.stringify(value).slice(0, 200)}`);
  return JSON.parse(JSON.stringify(value));
}

type Item = { id?: string; key?: string | null; name: string; spec: Record<string, unknown> };

function areaItems(blob: ConfigBlob, key: string): Item[] {
  let node: unknown = blob.areas;
  for (const segment of key.split(".")) node = isRecord(node) ? node[segment] : undefined;
  return isRecord(node) && Array.isArray(node.items) ? JSON.parse(JSON.stringify(node.items)) : [];
}

function itemLabel(key: string, item: Item): string {
  return key === "members.people" ? String(item.spec.email) : item.name;
}

const TYPE_ID = /\b[a-z]{2,6}_[0-9a-z]{26}\b/g;

/** Every id an export holds → a label that reads the same on both organizations. */
function idLabels(blob: ConfigBlob): Map<string, string> {
  const labels = new Map<string, string>();
  const visit = (value: unknown, owner: string) => {
    if (Array.isArray(value)) return value.forEach((entry) => visit(entry, owner));
    if (!isRecord(value)) return;
    if (typeof value.id === "string") {
      const name = typeof value.name === "string" ? value.name : typeof value.modelId === "string" ? value.modelId : typeof value.key === "string" ? value.key : null;
      if (name !== null && !labels.has(value.id)) labels.set(value.id, `<${owner}:${name}>`);
    }
    for (const [key, child] of Object.entries(value)) if (key !== "$ref") visit(child, owner);
  };
  for (const key of CONFIG_AREA_KEYS) {
    for (const item of areaItems(blob, key)) {
      if (item.id) labels.set(item.id, `<${key}:${itemLabel(key, item)}>`);
      visit(item.spec, `${key}:${item.name}`);
    }
  }
  return labels;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

/** One area, comparable across organizations and instances: ids and references become names. */
function portableArea(blob: ConfigBlob, key: ConfigAreaKey, organizationId: string, only?: ReadonlySet<string>): string {
  const labels = idLabels(blob);
  const items = areaItems(blob, key)
    .filter((item) => !only || only.has(itemLabel(key, item)))
    .map((item) => ({ name: itemLabel(key, item), spec: item.spec, ...(item.key ? { key: item.key } : {}) }));
  const json = JSON.stringify(items, (name, value: unknown) => (name === "id" ? undefined : value))
    .replaceAll(organizationId, "<organization>")
    .replace(TYPE_ID, (id) => labels.get(id) ?? "<id>");
  return JSON.stringify(canonical(JSON.parse(json)));
}

function planItems(plan: ConfigPlan): ConfigPlanItem[] {
  return plan.areas.flatMap((area) => area.items);
}

function requestOf(body: unknown): ConfigChangeRequestSummary {
  const value = isRecord(body) ? body.changeRequest : undefined;
  if (!isRecord(value) || typeof value.id !== "string") throw new Error(`Not a change request: ${JSON.stringify(body).slice(0, 200)}`);
  return JSON.parse(JSON.stringify(value));
}

function planOf(body: unknown): ConfigPlan {
  const value = isRecord(body) ? body.plan : undefined;
  if (!isRecord(value) || typeof value.planHash !== "string") throw new Error(`Not a plan: ${JSON.stringify(body).slice(0, 200)}`);
  return JSON.parse(JSON.stringify(value));
}

function counts(plan: ConfigPlan): string {
  const { create, update, rename, delete: removed, unchanged, skip, blocking } = plan.summary;
  return `+${create} add, ~${update + rename} change, −${removed} remove, ${unchanged} unchanged, ${skip} skipped, ${blocking} blocking`;
}

// ---------------------------------------------------------------------------

test("an owner moves their organization from OpenWork Cloud to a self-hosted Den with one config file, entering only the API key again", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.ownerWeb), ownerProbe = probe.on(world.ownerWeb);
  const shOwner = world.selfHosted.admin;
  let cloudBlob: ConfigBlob | undefined;
  let changeRequestId = "", importId = "";

  const openRequest = async (label: string, done: (request: ConfigChangeRequestSummary) => boolean) =>
    ownerProbe.eventually(async () => requestOf((await ownerProbe.api(shOwner, `/v1/config-blobs/change-requests/${changeRequestId}`)).body), {
      within: 120_000, intervalMs: 1_000, until: done, label,
    });
  const readPlan = async (id = changeRequestId) => planOf((await ownerProbe.api(shOwner, `/v1/config-blobs/change-requests/${id}/plan`)).body);
  const exportOf = async (which: "cloud" | "selfHosted") => {
    const den = world[which];
    const result = await ownerProbe.api(den.admin, "/v1/config-blobs/export");
    expect(result.response.status).toBe(200);
    return { blob: asBlob(result.body), text: result.text };
  };
  const uploadFile = async (title: string) => {
    await owner.navigate(world.url("/dashboard/config?tab=import"));
    await owner.see({ testId: "config-import-drop" }, { timeoutMs: 60_000 });
    await owner.attachFiles('[data-testid="config-import-input"]', [world.exportPath]);
    await owner.see({ testId: "config-import-file" }, { text: /Exported from "Acme Robotics" \(OpenWork Cloud\)/, timeoutMs: 30_000 });
    await owner.type({ label: "Enter a title for this import" }, title);
    await owner.click({ testId: "config-import-upload" });
    await owner.see({ testId: "config-change-request-screen" }, { timeoutMs: 60_000 });
    const list = await ownerProbe.api(shOwner, "/v1/config-blobs/change-requests");
    const requests = isRecord(list.body) && Array.isArray(list.body.changeRequests) ? list.body.changeRequests : [];
    const created = requests.map((entry) => requestOf({ changeRequest: entry })).find((entry) => entry.title === title);
    if (!created) throw new Error(`No change request titled ${title}`);
    return created.id;
  };

  await step("before: the self-hosted organization has its owner and one member, and none of the cloud's teams, providers, connectors or plugins", async () => {
    await owner.see({ testId: "config-screen" }, { timeoutMs: 120_000 });
    await owner.see({ testId: "config-overview" });
    const { blob } = await exportOf("selfHosted");
    const of = (key: ConfigAreaKey) => areaItems(blob, key).length;
    const empty = ["members.teams", "ai-gateway.byok", "connectors.mcp", "settings.web-origins", "plugins.plugins", "plugins.skills"] as const;
    const present = CONFIG_AREA_KEYS.filter((key) => of(key) > 0 && key !== "members.people").map((key) => `${key}: ${areaItems(blob, key).map((item) => item.name).join(", ")}`);
    expect(empty.map(of)).toEqual(empty.map(() => 0));
    expect(of("members.people")).toBe(2);
    evidence.recordAssertionEvidence(
      "The self-hosted organization starts empty",
      `${empty.map((key) => `${key}=${of(key)}`).join(", ")}; people=${of("members.people")} (owner + Riley); defaults already here: ${present.join("; ") || "none"}; instance ${blob.source?.instanceId}`,
      empty.every((key) => of(key) === 0),
    );
    await owner.navigate(world.url("/dashboard/members?tab=teams"));
    await owner.see({ text: "Everyone" }, { timeoutMs: 60_000 });
    await owner.notSee({ text: "Platform" });
    await owner.screenshot();
  });

  await step("the owner downloads the whole organization from OpenWork Cloud, and the provider's API key is not in the file", async () => {
    const exported = await world.exportFromCloud();
    cloudBlob = asBlob(exported.body);
    const filled = CONFIG_AREA_KEYS.filter((key) => areaItems(cloudBlob as ConfigBlob, key).length > 0);
    const items = filled.reduce((sum, key) => sum + areaItems(cloudBlob as ConfigBlob, key).length, 0);
    const providerSpec = JSON.stringify(areaItems(cloudBlob, "ai-gateway.byok")[0]?.spec ?? {});
    expect(exported.text).not.toContain(BYOK_API_KEY);
    expect(providerSpec).toContain("$secret");
    expect(cloudBlob.source?.deployment).toBe("cloud");
    const shInstance = (await exportOf("selfHosted")).blob.source?.instanceId;
    expect(cloudBlob.source?.instanceId).not.toBe(shInstance);
    evidence.recordAssertionEvidence(
      "Whole-organization export from OpenWork Cloud",
      `${cloudBlob.scope.length} areas in scope, ${filled.length} with items, ${items} items, ${exported.text.length} bytes; "${BYOK_API_KEY}" found 0 times; API key exported as a $secret placeholder; source instance ${cloudBlob.source?.instanceId} ≠ self-hosted ${shInstance}`,
      !exported.text.includes(BYOK_API_KEY) && providerSpec.includes("$secret"),
    );
    await owner.navigate(world.url("/dashboard/config?tab=import"));
    await owner.see({ testId: "config-import" }, { timeoutMs: 60_000 });
  });

  await step("the owner uploads the file on the self-hosted Config page, and the change request lists what it will add", async () => {
    changeRequestId = await uploadFile("Move from OpenWork Cloud");
    importId = changeRequestId;
    const request = await openRequest("analyzed", (entry) => entry.status === "needs_review" || entry.status === "invalid");
    expect(request.status).toBe("needs_review");
    expect(request.sourceDeployment).toBe("cloud");
    const plan = await readPlan();
    const items = planItems(plan);
    expect(items.filter((item) => item.op === "delete")).toEqual([]);
    const creates = items.filter((item) => item.op === "create");
    expect(creates.map((item) => item.area)).toEqual(expect.arrayContaining(["members.teams", "ai-gateway.byok", "connectors.mcp", "desktop-policies", "settings.web-origins", "plugins.plugins", "plugins.skills"]));
    await owner.see({ testId: "config-status-chip" }, { text: /review/i, timeoutMs: 60_000 });
    await owner.click({ role: "tab", label: /^Review/ });
    await owner.see({ testId: "config-step-review" }, { timeoutMs: 30_000 });
    await owner.see({ text: "Acme LLM" });
    evidence.recordAssertionEvidence(
      "The plan for an empty target is mostly creates",
      `${counts(plan)} (the API key); creates by area: ${[...new Set(creates.map((item) => item.area))].map((area) => `${area}×${creates.filter((item) => item.area === area).length}`).join(", ")}`,
      creates.length > 0 && plan.summary.delete === 0,
    );
    await owner.screenshot();
  });

  await step("the Secrets step asks for the provider's API key, and the owner pastes it", async () => {
    const before = await readPlan();
    const secrets = planItems(before).flatMap((item) => item.secrets ?? []);
    const needed = secrets.filter((secret) => secret.decision === null);
    expect(needed.map((secret) => secret.path.split("/")[0])).toEqual(["ai-gateway.byok"]);
    await owner.click({ role: "tab", label: /^Secrets/ });
    await owner.see({ testId: "config-step-secrets" }, { timeoutMs: 30_000 });
    await owner.click({ label: /^Secret for / });
    await owner.click({ role: "option", label: "Enter a value" });
    await owner.type({ label: /^Value for / }, BYOK_API_KEY);
    await owner.click({ role: "button", label: "Save value" });
    const after = await ownerProbe.eventually(() => readPlan(), { within: 30_000, until: (plan) => plan.summary.blocking === 0, label: "the API key is entered" });
    const decided = planItems(after).flatMap((item) => item.secrets ?? []).filter((secret) => secret.path === needed[0]?.path);
    expect(decided[0]?.decision).toBe("value");
    expect(JSON.stringify(after)).not.toContain(BYOK_API_KEY);
    expect(await ownerProbe.has(BYOK_API_KEY)).toBe(false);
    evidence.recordAssertionEvidence(
      "One secret to enter; the value is stored write-only",
      `secrets in the file: ${secrets.length}; to enter: ${needed.map((secret) => secret.field).join(", ")}; after saving: decision=${decided[0]?.decision}, blocking=${after.summary.blocking}; key shown on the page or in the plan: no`,
      after.summary.blocking === 0 && decided[0]?.decision === "value",
    );
    await owner.screenshot();
  });

  await step("the owner approves and applies, and the report shows every item written without a failure", async () => {
    await owner.click({ testId: "config-approve" });
    await owner.see({ testId: "config-apply" }, { timeoutMs: 60_000 });
    await owner.click({ testId: "config-apply" });
    const request = await openRequest("applied", (entry) => entry.status === "applied" || entry.status === "failed");
    const detail = await ownerProbe.api(shOwner, `/v1/config-blobs/change-requests/${changeRequestId}`);
    const runs = isRecord(detail.body) && Array.isArray(detail.body.runs) ? detail.body.runs : [];
    const run = isRecord(runs[0]) ? runs[0] : {};
    const runCounts = isRecord(run.counts) ? run.counts : {};
    const failedItems = Array.isArray(run.items) ? run.items.filter((item) => isRecord(item) && item.status !== "applied" && item.status !== "noop") : [];
    expect(request.status, `${request.errors.join("; ")} ${JSON.stringify(failedItems).slice(0, 1500)}`).toBe("applied");
    await owner.see({ testId: "config-apply-runs" }, { timeoutMs: 60_000 });
    await owner.see({ testId: "config-status-chip" }, { text: /Applied/, timeoutMs: 30_000 });
    await owner.click({ text: "Attempt 1" });
    await owner.see({ testId: "config-apply-run-items" }, { timeoutMs: 30_000 });
    expect(runs).toHaveLength(1);
    expect(runCounts.failed).toBe(0);
    expect(runCounts.not_reached).toBe(0);
    evidence.recordAssertionEvidence(
      "One apply run, nothing failed",
      `status=${request.status}; run 1: ${Object.entries(runCounts).map(([key, value]) => `${key}=${String(value)}`).join(", ")}`,
      request.status === "applied" && runCounts.failed === 0,
    );
    await owner.screenshot();
  });

  await step("after: the self-hosted organization has the same configuration as on OpenWork Cloud, area by area", async () => {
    if (!cloudBlob) throw new Error("No cloud export");
    const { blob: shBlob } = await exportOf("selfHosted");
    const unsupported = new Set((await readPlan()).areas.filter((area) => area.items.length > 0 && area.items.every((item) => item.op === "skip" && (item.reasons ?? []).some((reason) => reason.includes("not available")))).map((area) => area.area));
    const compared = CONFIG_AREA_KEYS.filter((key) => areaItems(cloudBlob as ConfigBlob, key).length > 0 && key !== "members.people" && !unsupported.has(key));
    const different: string[] = [];
    for (const key of compared) {
      const cloudNames = new Set(areaItems(cloudBlob, key).map((item) => itemLabel(key, item)));
      const left = portableArea(cloudBlob, key, world.cloudOrgId);
      const right = portableArea(shBlob, key, world.selfHostedOrgId, cloudNames);
      const same = left === right;
      const extra = areaItems(shBlob, key).map((item) => itemLabel(key, item)).filter((name) => !cloudNames.has(name));
      if (!same) different.push(`${key}\ncloud: ${left}\nself-hosted: ${right}`);
      const names = [...cloudNames];
      evidence.recordAssertionEvidence(`${key}`, `${names.length} on cloud (${names.slice(0, 4).join(", ")}${names.length > 4 ? ", …" : ""}) → ${same ? "identical here after normalizing ids" : "DIFFERENT here"}${extra.length ? `; also here before the import: ${extra.join(", ")}` : ""}`, same);
    }
    if (unsupported.size > 0) evidence.recordAssertionEvidence("Cloud-only areas", `skipped as not available on self-hosted: ${[...unsupported].join(", ")}`, [...unsupported].every((key) => key.startsWith("ai-gateway.")));
    expect(different, different.join("\n\n")).toEqual([]);
    await owner.navigate(world.url("/dashboard/members?tab=teams"));
    await owner.see({ text: "Platform" }, { timeoutMs: 60_000 });
    await owner.see({ text: "Research" });
    await owner.screenshot();
  });

  await step("after: the items it created keep their OpenWork Cloud IDs, because this is another OpenWork instance", async () => {
    if (!cloudBlob) throw new Error("No cloud export");
    const { blob: shBlob } = await exportOf("selfHosted");
    // Items the import created (defaults both organizations already had, like the default desktop policy, were matched, not created).
    const importPlan = await readPlan(importId);
    const created = planItems(importPlan).filter((item) => item.op === "create" && item.blob?.id);
    const kept: string[] = [], renewed: string[] = [];
    for (const item of created) {
      const twin = areaItems(shBlob, item.area).find((entry) => entry.id === item.blob?.id);
      (twin ? kept : renewed).push(`${item.area}:${item.blob?.name}`);
    }
    const matchedHere = planItems(importPlan).filter((item) => item.op !== "create" && item.target && item.blob?.id && item.blob.id !== item.target.id).length;
    const provider = areaItems(shBlob, "ai-gateway.byok").find((item) => item.name === "Acme LLM");
    expect(provider?.id).toBe(world.byokId);
    expect(created.length).toBeGreaterThan(0);
    expect(renewed).toEqual([]);
    await owner.navigate(world.url("/dashboard/custom-llm-providers"));
    await owner.see({ text: "Acme LLM" }, { timeoutMs: 60_000 });
    evidence.recordAssertionEvidence(
      "Source TypeIDs reused across instances",
      `provider Acme LLM: cloud ${world.byokId} = self-hosted ${provider?.id}; ${kept.length} of ${created.length} created items kept their cloud id${renewed.length ? `; new ids: ${renewed.join(", ")}` : ""}; ${matchedHere} items that already existed here (defaults, the owner) keep this server's ids`,
      provider?.id === world.byokId && renewed.length === 0,
    );
    await owner.screenshot();
  });

  await step("after: the cloud's people are pending invitations here, and no invite email was sent", async () => {
    if (!cloudBlob) throw new Error("No cloud export");
    const { blob: shBlob } = await exportOf("selfHosted");
    const cloudPeople = areaItems(cloudBlob, "members.people").map((item) => String(item.spec.email));
    const here = new Map(areaItems(shBlob, "members.people").map((item) => [String(item.spec.email), String(item.spec.status)]));
    const statuses = cloudPeople.map((email) => `${email.split("+")[0]}=${email === world.owner.email ? "owner" : here.get(email)}`);
    expect(cloudPeople.every((email) => email === world.owner.email || here.get(email) === "invited")).toBe(true);
    const sent = await ownerProbe.api(shOwner, "/v1/dev/emails?template=organizationInvite");
    const cloudSent = await ownerProbe.api(world.cloud.admin, "/v1/dev/emails?template=organizationInvite");
    // Only invitations to the cloud's people count: provisioning the self-hosted organization invited Riley through the same outbox.
    const imported = new Set(cloudPeople.filter((email) => email !== world.owner.email));
    const emails = (body: unknown) => (isRecord(body) && Array.isArray(body.emails) ? body.emails : []).filter((entry) => isRecord(entry) && imported.has(String(entry.to)));
    const allHere = isRecord(sent.body) && Array.isArray(sent.body.emails) ? sent.body.emails.length : 0;
    expect(emails(sent.body)).toHaveLength(0);
    // Witness: the same outbox captures invitations, as the ones sent on OpenWork Cloud show.
    expect(emails(cloudSent.body).length).toBeGreaterThan(0);
    await owner.navigate(world.url("/dashboard/members"));
    await owner.see({ text: world.invitedEmail }, { timeoutMs: 60_000 });
    evidence.recordAssertionEvidence(
      "People arrive as invitations, silently",
      `${statuses.join(", ")}; invite emails to these people here: ${emails(sent.body).length} (this outbox holds ${allHere}, the invitation that set up Riley on this server; the cloud outbox holds ${emails(cloudSent.body).length} to the same people)`,
      emails(sent.body).length === 0,
    );
    await owner.screenshot();
  });

  await step("then: uploading the same file again finds nothing to change", async () => {
    changeRequestId = await uploadFile("Move from OpenWork Cloud, again");
    const request = await openRequest("re-import analyzed", (entry) => entry.status === "needs_review" || entry.status === "invalid");
    expect(request.status).toBe("needs_review");
    const plan = await readPlan();
    const writes = planItems(plan).filter((item) => ["create", "update", "rename", "delete"].includes(item.op));
    expect(writes.map((item) => `${item.area}:${item.blob?.name}:${item.op}`)).toEqual([]);
    const tiers = planItems(plan).filter((item) => item.op === "unchanged").reduce<Record<string, number>>((acc, item) => ({ ...acc, [item.matchedBy ?? "none"]: (acc[item.matchedBy ?? "none"] ?? 0) + 1 }), {});
    await owner.see({ testId: "config-counts" }, { timeoutMs: 30_000 });
    evidence.recordAssertionEvidence(
      "Re-import: all unchanged",
      `${counts(plan)}; matched by ${Object.entries(tiers).map(([tier, count]) => `${tier}×${count}`).join(", ")}`,
      writes.length === 0,
    );
    await owner.screenshot();
  });

  await step("a member without organization settings access can't open Config or approve, and a standard API key is refused", async () => {
    const member = user.on(world.memberWeb), memberProbe = probe.on(world.memberWeb);
    await member.navigate(world.url("/dashboard/config"));
    await memberProbe.eventually(() => memberProbe.dom('[data-testid="member-dashboard"], [data-testid="admin-access-state"][data-access-state="locked"]'), {
      within: 60_000, until: (value) => value.elements.length > 0, label: "Config is closed to the member",
    });
    await member.notSee({ testId: "config-screen" });
    const plan = await readPlan();
    const approve = await world.approveAs(world.riley, changeRequestId, plan.planHash);
    const keyExport = await world.withStandardKey("GET", "/v1/config-blobs/export");
    const keyUpload = await world.withStandardKey("POST", "/v1/config-blobs/change-requests", { blob: {}, mode: "merge" });
    const error = (body: unknown) => (isRecord(body) ? String(body.error) : String(body));
    // A request touching areas the member can't view doesn't exist for them: refused as not found, not as forbidden.
    expect(approve.status).toBe(404);
    expect(error(approve.body)).toBe("change_request_not_found");
    expect(error(keyExport.body)).toBe("config_scope_required");
    expect(keyExport.status).toBe(403);
    expect(keyUpload.status).toBe(403);
    const still = await openRequest("still waiting", () => true);
    expect(still.approvals).toEqual([]);
    evidence.recordAssertionEvidence(
      "Refused without organization settings access or a config token",
      `member opens /dashboard/config → sent back to the dashboard; member approve → ${approve.status} ${error(approve.body)} (the request is hidden from them); standard key export → ${keyExport.status} ${error(keyExport.body)}; standard key upload → ${keyUpload.status} ${error(keyUpload.body)}; approvals on the request: ${still.approvals.length}`,
      approve.status === 404 && keyExport.status === 403 && keyUpload.status === 403,
    );
    await member.screenshot();
  });
});
