import { chmod, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  createOrgConnection,
  createPluginWithSkill,
  denFetch,
  freshSession,
  provisionOrg,
  seedSessions,
  signIn,
} from "@openwork/behaviors";
import { desktop, freePort, localHost, resolveInstalledProductionDesktopState, stopOwnedElectronSurface } from "@openwork/hosts";
import { Effect, Exit, Scope } from "effect";
import { createConnection } from "mysql2/promise";
import { z } from "zod";
import type { ProvisionedOrg } from "@openwork/behaviors";
import type { DesktopHandle, InstalledProductionDesktopState } from "@openwork/hosts";
import { app as bootApp, liveSharedProductionApp } from "./desktop-app.ts";
import type { App } from "./desktop-app.ts";
import { defaultReuseAdmin, personDefaults, server } from "./den.ts";
import type { Den } from "./den.ts";
import { DEMO_PASSWORD, ensureKindDenReady, exposeEndpointHandles, kubeProfileConfig } from "./kind-stack.ts";
import { liteLlm } from "./litellm.ts";
import type { LiteLlmHandle } from "./litellm.ts";
import { liteLlmPerMemberProvider } from "./litellm-provider.ts";
import { mcpMock } from "./mock.ts";
import { resolvePlace, validateDatabaseName } from "./place.ts";
import type { Place } from "./place.ts";
import { defineWorld, resolveWorldPerson, usesLiveSharedProductionState, worldTopologySchema } from "./topology.ts";
import type { WorldDefinition, WorldOrg, WorldPerson, WorldTopology } from "./topology.ts";
import type { DenRef, DenSession } from "@openwork/behaviors";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const WORLDS_DIR = join(REPO_ROOT, "evals", "results", ".worlds");
const RESULTS_DIR = join(REPO_ROOT, "evals", "results");
const DEFAULT_LOCAL_MYSQL_URL = "mysql://root:password@127.0.0.1:3306";
const SNAPSHOT_ENV_KEY = /^(DEN_|OPENWORK_)[A-Z0-9_]+$/;
const SNAPSHOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SNAPSHOT_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const SNAPSHOT_FAULT = /^[a-z0-9][a-z0-9-]{0,127}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const ALLOWED_WORKSPACE_ROOTS = [
  resolve(tmpdir()),
  RESULTS_DIR,
  ...(process.platform === "win32" ? [] : [resolve("/tmp")]),
];

export interface World extends AsyncDisposable {
  name: string;
  topology: WorldTopology;
  den: Den;
  apps: Record<string, App>;
  llmProviders: Record<string, WorldLlmProviderRuntime>;
  app(name: string): App;
  snapshotPath: string;
}

export interface WorldLlmProviderRuntime {
  providerId: string;
  providerRecordId: string;
  witness: string;
  baseUrl: string;
  modelId: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  metadataAction: "updated" | "unchanged";
}

export interface WorldSnapshotResolved {
  den: {
    apiUrl: string;
    webUrl: string;
    origin: "attached" | "launched";
    substrate?: "kind";
    database?: string;
    ports?: { api: number; web: number };
  } | { origin: "none" };
  apps: Record<string, {
    cdpUrl: string;
    workspaceId: string | null;
    sessions: string[];
    owner?: { pid: number; profileDir: string };
  }>;
}

export interface WorldTeardownResult {
  denPorts: number[];
  apps: string[];
  database?: string;
}

export interface ResumedWorld {
  name: string;
  den: { ref: DenRef; admin: DenSession };
  apps: Record<string, DesktopHandle>;
  detach(): Promise<void>;
  teardown(): Promise<WorldTeardownResult>;
}

export interface WorldSnapshot {
  version: 1;
  name: string;
  createdAt: string;
  place: "local" | "daytona";
  topology: WorldTopology;
  resolved: WorldSnapshotResolved;
}

export interface BuildSnapshotInput {
  name: string;
  createdAt?: string;
  place: "local" | "daytona";
  topology: WorldTopology;
  resolved: WorldSnapshotResolved;
}

const resolvedAppSchema = z.strictObject({
  cdpUrl: z.string(),
  workspaceId: z.string().nullable(),
  sessions: z.array(z.string()),
  owner: z.strictObject({
    pid: z.number().int().positive(),
    profileDir: z.string(),
  }).optional(),
});

const resolvedPortsSchema = z.strictObject({
  api: z.number().int().min(1024).max(65_535),
  web: z.number().int().min(1024).max(65_535),
});

const worldSnapshotSchema = z.strictObject({
  version: z.literal(1),
  name: z.string(),
  createdAt: z.iso.datetime(),
  place: z.enum(["local", "daytona"]),
  topology: worldTopologySchema,
  resolved: z.strictObject({
    den: z.union([
      z.strictObject({
        apiUrl: z.string(),
        webUrl: z.string(),
        origin: z.enum(["attached", "launched"]),
        substrate: z.literal("kind").optional(),
        database: z.string().optional(),
        ports: resolvedPortsSchema.optional(),
      }),
      z.strictObject({ origin: z.literal("none") }),
    ]),
    apps: z.record(z.string(), resolvedAppSchema),
  }),
});

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function displayedSnapshotValue(value: unknown): string {
  const encoded = JSON.stringify(value);
  const displayed = encoded === undefined ? String(value) : encoded;
  return displayed.length > 300 ? `${displayed.slice(0, 297)}...` : displayed;
}

function rejectSnapshotField(field: string, value: unknown, requirement: string): never {
  throw new Error(
    `Untrusted world snapshot rejected: ${field}=${displayedSnapshotValue(value)}; ${requirement}. Use a generated world snapshot or correct this field.`,
  );
}

function snapshotValueAtPath(value: unknown, path: readonly PropertyKey[]): unknown {
  let current = value;
  for (const segment of path) {
    if (typeof segment === "number" && Array.isArray(current)) {
      current = current[segment];
      continue;
    }
    if (typeof segment === "string" && isRecord(current)) {
      current = current[segment];
      continue;
    }
    return undefined;
  }
  return current;
}

function parseSnapshotStructure(jsonText: string): { json: unknown; snapshot: WorldSnapshot } {
  let json: unknown;
  try {
    json = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`Untrusted world snapshot is not valid JSON: ${messageText(error)}`);
  }
  const parsed = worldSnapshotSchema.safeParse(json);
  if (parsed.success) return { json, snapshot: parsed.data };
  const issue = parsed.error.issues[0];
  if (!issue) throw new Error("Untrusted world snapshot failed structural validation.");
  const field = issue.path.length > 0 ? issue.path.map(String).join(".") : "<root>";
  throw new Error(
    `Untrusted world snapshot rejected: ${field}=${displayedSnapshotValue(snapshotValueAtPath(json, issue.path))}; ${issue.message}.`,
  );
}

function validateSnapshotPort(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1024 || value > 65_535) {
    rejectSnapshotField(field, value, "expected an integer port from 1024 to 65535");
  }
}

function validateSnapshotWorkspacePath(field: string, value: string): void {
  if (!isAbsolute(value)) {
    rejectSnapshotField(field, value, "expected an absolute path inside a temporary directory or evals/results");
  }
  const candidate = resolve(value);
  const allowed = ALLOWED_WORKSPACE_ROOTS.some((root) => {
    const child = relative(root, candidate);
    return child.length > 0 && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
  });
  if (!allowed) {
    rejectSnapshotField(
      field,
      value,
      `expected a path inside one of ${ALLOWED_WORKSPACE_ROOTS.map(displayedSnapshotValue).join(", ")}`,
    );
  }
}

function validateSnapshotCdpUrl(field: string, value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    rejectSnapshotField(field, value, "expected an http(s) loopback CDP URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname)) {
    rejectSnapshotField(field, value, "expected an http(s) URL whose hostname is 127.0.0.1 or localhost");
  }
  if (!url.port) {
    rejectSnapshotField(field, value, "expected an explicit CDP port from 1024 to 65535");
  }
  validateSnapshotPort(`${field}.port`, Number(url.port));
}

function validateSnapshotLoopbackUrlPort(field: string, value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // Malformed and non-HTTP resolved Den URLs cannot reach the local freePort teardown path.
    return;
  }
  if (LOOPBACK_HOSTS.has(url.hostname) && url.port) {
    validateSnapshotPort(`${field}.port`, Number(url.port));
  }
}

function validateUntrustedSnapshot(snapshot: WorldSnapshot): void {
  if (!SNAPSHOT_NAME.test(snapshot.name)) {
    rejectSnapshotField("name", snapshot.name, "expected a filesystem-safe name using letters, numbers, dots, underscores, or hyphens");
  }
  const sharedProductionState = usesLiveSharedProductionState(snapshot.topology);
  if (sharedProductionState && snapshot.place !== "local") {
    rejectSnapshotField("place", snapshot.place, "live-shared installed-production desktop snapshots must use local placement");
  }
  if (sharedProductionState !== (snapshot.resolved.den.origin === "none")) {
    rejectSnapshotField(
      "resolved.den.origin",
      snapshot.resolved.den.origin,
      "origin none is reserved for live-shared installed-production desktop worlds and is required by them",
    );
  }

  for (const [key, value] of Object.entries(snapshot.topology.den.env ?? {})) {
    if (!SNAPSHOT_ENV_KEY.test(key)) {
      rejectSnapshotField(`topology.den.env.${key}`, value, "environment keys must match ^(DEN_|OPENWORK_)[A-Z0-9_]+$");
    }
    if (value.includes("\0")) {
      rejectSnapshotField(`topology.den.env.${key}`, value, "environment values must not contain NUL bytes");
    }
  }

  if (snapshot.topology.den.ports) {
    validateSnapshotPort("topology.den.ports.api", snapshot.topology.den.ports.api);
    validateSnapshotPort("topology.den.ports.web", snapshot.topology.den.ports.web);
  }
  for (const [name, app] of Object.entries(snapshot.topology.apps ?? {})) {
    if (app.workspacePath !== undefined) {
      validateSnapshotWorkspacePath(`topology.apps.${name}.workspacePath`, app.workspacePath);
    }
    if (app.model !== undefined && !SNAPSHOT_MODEL.test(app.model)) {
      rejectSnapshotField(`topology.apps.${name}.model`, app.model, "expected a model identifier containing only letters, numbers, ._:/@+-");
    }
    if (
      app.localServerDelayMs !== undefined
      && (!Number.isInteger(app.localServerDelayMs) || app.localServerDelayMs < 0 || app.localServerDelayMs > 300_000)
    ) {
      rejectSnapshotField(`topology.apps.${name}.localServerDelayMs`, app.localServerDelayMs, "expected an integer from 0 to 300000");
    }
  }
  for (const [name, app] of Object.entries(snapshot.resolved.apps)) {
    if (sharedProductionState && app.owner === undefined) {
      rejectSnapshotField(`resolved.apps.${name}.owner`, app.owner, "live-shared app snapshots require an owned dev process receipt");
    }
    if (app.owner) {
      const profileRoot = resolve(RESULTS_DIR, ".surfaces");
      const candidate = resolve(app.owner.profileDir);
      const child = relative(profileRoot, candidate);
      if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
        rejectSnapshotField(`resolved.apps.${name}.owner.profileDir`, app.owner.profileDir, "expected an eval-owned profile inside evals/results/.surfaces");
      }
    }
  }
  for (const [name, witness] of Object.entries(snapshot.topology.witnesses ?? {})) {
    if (witness.kind === "mcp" && witness.fault !== undefined && !SNAPSHOT_FAULT.test(witness.fault)) {
      rejectSnapshotField(`topology.witnesses.${name}.fault`, witness.fault, "expected a lowercase fault id containing only letters, numbers, or hyphens");
    }
  }

  if (snapshot.resolved.den.origin !== "none") {
    const database = snapshot.resolved.den.database;
    if (database !== undefined) {
      try {
        validateDatabaseName(database);
      } catch {
        rejectSnapshotField("resolved.den.database", database, "expected a valid ephemeral database name matching ^[a-z][a-z0-9_]{0,62}$");
      }
      if (!database.startsWith("openwork_eval_")) {
        rejectSnapshotField("resolved.den.database", database, "only generated openwork_eval_* databases may be torn down");
      }
    }
    if (snapshot.resolved.den.ports) {
      validateSnapshotPort("resolved.den.ports.api", snapshot.resolved.den.ports.api);
      validateSnapshotPort("resolved.den.ports.web", snapshot.resolved.den.ports.web);
    }
    validateSnapshotLoopbackUrlPort("resolved.den.apiUrl", snapshot.resolved.den.apiUrl);
    validateSnapshotLoopbackUrlPort("resolved.den.webUrl", snapshot.resolved.den.webUrl);
  }
  for (const [name, app] of Object.entries(snapshot.resolved.apps)) {
    validateSnapshotCdpUrl(`resolved.apps.${name}.cdpUrl`, app.cdpUrl);
  }
}

function primaryOrganization(topology: WorldTopology): [string, WorldOrg] {
  const primary = Object.entries(topology.den.orgs)[0];
  if (!primary) throw new Error("World topology must define at least one organization in den.orgs.");
  return primary;
}

function resolveOrganizationPeople(org: WorldOrg, env: NodeJS.ProcessEnv): WorldOrg {
  const members: Record<string, WorldPerson> = {};
  for (const [key, person] of Object.entries(org.members ?? {})) {
    members[key] = resolveWorldPerson(person, env);
  }
  return {
    ...org,
    ...(org.admin === undefined ? {} : { admin: resolveWorldPerson(org.admin, env) }),
    ...(org.members === undefined ? {} : { members }),
  };
}

function resolveOrganizationMap(
  organizations: Record<string, WorldOrg>,
  env: NodeJS.ProcessEnv,
): Record<string, WorldOrg> {
  const resolved: Record<string, WorldOrg> = {};
  for (const [name, org] of Object.entries(organizations)) {
    resolved[name] = resolveOrganizationPeople(org, env);
  }
  return resolved;
}

function snapshotPerson(person: WorldPerson): WorldPerson {
  return person.secretRef === undefined ? person : { secretRef: person.secretRef };
}

function snapshotOrganization(org: WorldOrg): WorldOrg {
  const members: Record<string, WorldPerson> = {};
  for (const [key, person] of Object.entries(org.members ?? {})) {
    members[key] = snapshotPerson(person);
  }
  return {
    ...org,
    ...(org.admin === undefined ? {} : { admin: snapshotPerson(org.admin) }),
    ...(org.members === undefined ? {} : { members }),
  };
}

function snapshotTopology(topology: WorldTopology): WorldTopology {
  const organizations: Record<string, WorldOrg> = {};
  for (const [name, org] of Object.entries(topology.den.orgs)) {
    organizations[name] = snapshotOrganization(org);
  }
  return { ...topology, den: { ...topology.den, orgs: organizations } };
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function provisionWorldLlmProviders(
  den: Den,
  organizationId: string,
  org: WorldOrg,
  topology: WorldTopology,
  gateways: Record<string, LiteLlmHandle>,
): Promise<Record<string, WorldLlmProviderRuntime>> {
  const providers = org.llmProviders ?? [];
  if (providers.length === 0) return {};
  const realized: Record<string, WorldLlmProviderRuntime> = {};
  for (const provider of providers) {
    const witness = topology.witnesses?.[provider.witness];
    const gateway = gateways[provider.witness];
    if (!witness || witness.kind !== "litellm" || !gateway) {
      throw new Error(`LiteLLM witness ${JSON.stringify(provider.witness)} was not booted for provider ${JSON.stringify(provider.name)}.`);
    }
    const provisioned = await liteLlmPerMemberProvider(den.admin, {
      gateway,
      orgId: organizationId,
      providerId: provider.providerId,
      name: provider.name,
      envVar: provider.env,
      modelId: witness.modelId,
      modelName: provider.modelName,
    });
    realized[provider.providerId] = {
      providerId: provisioned.providerId,
      providerRecordId: provisioned.providerRecordId,
      witness: provider.witness,
      baseUrl: provisioned.baseUrl,
      modelId: provisioned.modelId,
      maxInputTokens: provisioned.maxInputTokens,
      maxOutputTokens: provisioned.maxOutputTokens,
      metadataAction: provisioned.metadataAction,
    };
  }
  return realized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  return typeof value[key] === "string" ? value[key] : null;
}

async function organizationIdByName(admin: DenSession, name: string): Promise<string> {
  const listed = await denFetch(admin, "/v1/me/orgs", { headers: auth(admin.token) });
  const organizations = isRecord(listed.body) && Array.isArray(listed.body.orgs)
    ? listed.body.orgs.filter(isRecord)
    : [];
  const organization = organizations.find((candidate) => candidate.name === name);
  const id = organization ? stringField(organization, "id") : null;
  if (!listed.response.ok || !id) {
    throw new Error(`Organization ${JSON.stringify(name)} was not visible to its admin: HTTP ${listed.response.status} ${listed.text.slice(0, 500)}`);
  }
  return id;
}

async function organizationMemberId(
  den: Den,
  organizationId: string,
  memberKey: string,
): Promise<string> {
  const member = den.members[memberKey];
  if (!member) {
    throw new Error(`World desktop policy member ${JSON.stringify(memberKey)} was not provisioned.`);
  }
  const route = "/v1/me/orgs";
  const listed = await denFetch(member, route, { headers: auth(member.token) });
  const organizations = isRecord(listed.body) && Array.isArray(listed.body.orgs)
    ? listed.body.orgs.filter(isRecord)
    : [];
  const organization = organizations.find((candidate) => stringField(candidate, "id") === organizationId);
  const memberId = organization
    ? stringField(organization, "membershipId") ?? stringField(organization, "orgMemberId")
    : null;
  if (!listed.response.ok || !memberId) {
    throw new Error(
      `GET ${route} could not resolve member ${JSON.stringify(memberKey)} in organization ${JSON.stringify(organizationId)}: HTTP ${listed.response.status} ${listed.text.slice(0, 500)}`,
    );
  }
  return memberId;
}

async function policyMemberIds(
  den: Den,
  organizationId: string,
  memberKeys: string[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const memberKey of memberKeys) {
    ids.push(await organizationMemberId(den, organizationId, memberKey));
  }
  return ids;
}

async function createPolicyTeam(
  den: Den,
  organizationId: string,
  team: { name: string; members: string[] },
): Promise<string> {
  const route = "/v1/teams";
  const created = await denFetch(den.admin, route, {
    method: "POST",
    headers: { ...auth(den.admin.token), "x-openwork-org-id": organizationId },
    body: JSON.stringify({
      name: team.name,
      memberIds: await policyMemberIds(den, organizationId, team.members),
    }),
  });
  const teamRecord = isRecord(created.body) && isRecord(created.body.team) ? created.body.team : null;
  const teamId = teamRecord ? stringField(teamRecord, "id") : null;
  if (created.response.status !== 201 || !teamId) {
    throw new Error(`POST ${route} failed for team ${JSON.stringify(team.name)}: HTTP ${created.response.status} ${created.text.slice(0, 500)}`);
  }
  return teamId;
}

async function createDesktopPolicy(
  den: Den,
  organizationId: string,
  policy: {
    name: string;
    priority?: number;
    promptCards?: { title: string; prompt: string }[];
    members?: string[];
    teams?: { name: string; members: string[] }[];
  },
): Promise<void> {
  const teamIds: string[] = [];
  for (const team of policy.teams ?? []) {
    teamIds.push(await createPolicyTeam(den, organizationId, team));
  }
  const route = "/v1/desktop-policies";
  const promptCards = policy.promptCards ?? [];
  const created = await denFetch(den.admin, route, {
    method: "POST",
    headers: { ...auth(den.admin.token), "x-openwork-org-id": organizationId },
    body: JSON.stringify({
      policyName: policy.name,
      priority: policy.priority ?? 1,
      isEnabled: true,
      policy: {
        onboardingPrompts: promptCards.map((card) => card.prompt),
        onboardingPromptDescriptions: promptCards.map((card) => card.title),
      },
      memberIds: await policyMemberIds(den, organizationId, policy.members ?? []),
      teamIds,
    }),
  });
  if (created.response.status !== 201) {
    throw new Error(`POST ${route} failed for policy ${JSON.stringify(policy.name)}: HTTP ${created.response.status} ${created.text.slice(0, 500)}`);
  }
}

async function realizePrimaryOrganizationContent(
  den: Den,
  organizationId: string,
  org: WorldOrg,
  topology: WorldTopology,
  gateways: Record<string, LiteLlmHandle>,
): Promise<Record<string, WorldLlmProviderRuntime>> {
  if (org.capabilities !== undefined) {
    const route = `/v1/admin/organizations/${organizationId}/capabilities`;
    const updated = await denFetch(den.admin, route, {
      method: "PUT",
      headers: auth(den.admin.token),
      body: JSON.stringify({ capabilities: org.capabilities }),
    });
    if (!updated.response.ok) {
      throw new Error(`PUT ${route} failed: HTTP ${updated.response.status} ${updated.text.slice(0, 500)}`);
    }
  }

  for (const plugin of org.plugins ?? []) {
    try {
      await createPluginWithSkill(den.admin, {
        name: plugin.name,
        skillName: plugin.skill.name,
        skillBody: plugin.skill.body,
        ...(plugin.description === undefined ? {} : { description: plugin.description }),
        ...(plugin.skill.description === undefined ? {} : { skillDescription: plugin.skill.description }),
      });
    } catch (error) {
      throw new Error(`POST /v1/plugins failed for plugin ${JSON.stringify(plugin.name)}: ${messageText(error).slice(0, 500)}`);
    }
  }

  for (const connection of org.connections ?? []) {
    const mock = den.mocks[connection.witness];
    if (!mock) {
      throw new Error(`World connection ${JSON.stringify(connection.name)} witness ${JSON.stringify(connection.witness)} was not booted.`);
    }
    try {
      await createOrgConnection(den.admin, {
        name: connection.name,
        url: mock.mcpUrl,
        authType: "oauth",
        credentialMode: "per_member",
        access: { orgWide: true },
      });
    } catch (error) {
      throw new Error(`POST /v1/mcp-connections failed for connection ${JSON.stringify(connection.name)}: ${messageText(error).slice(0, 500)}`);
    }
  }

  for (const policy of org.desktopPolicies ?? []) {
    await createDesktopPolicy(den, organizationId, policy);
  }
  return provisionWorldLlmProviders(den, organizationId, org, topology, gateways);
}

async function addPrimaryAdminToOrganization(
  provisioned: ProvisionedOrg,
  primaryAdmin: DenSession,
  primaryOrganizationId: string,
): Promise<void> {
  const invited = await denFetch(provisioned.admin, "/v1/invitations", {
    method: "POST",
    headers: auth(provisioned.admin.token),
    body: JSON.stringify({ email: primaryAdmin.email, role: "member" }),
  });
  const inviteToken = stringField(invited.body, "inviteToken");
  if (!invited.response.ok || !inviteToken) {
    throw new Error(`Primary admin invitation failed: HTTP ${invited.response.status} ${invited.text.slice(0, 500)}`);
  }
  const accepted = await denFetch(primaryAdmin, "/v1/orgs/invitations/accept", {
    method: "POST",
    headers: auth(primaryAdmin.token),
    body: JSON.stringify({ id: inviteToken }),
  });
  if (!accepted.response.ok || !isRecord(accepted.body) || accepted.body.accepted !== true) {
    throw new Error(`Primary admin invitation accept failed: HTTP ${accepted.response.status} ${accepted.text.slice(0, 500)}`);
  }
  const selected = await denFetch(primaryAdmin, "/v1/me/active-organization", {
    method: "POST",
    headers: auth(primaryAdmin.token),
    body: JSON.stringify({ organizationId: primaryOrganizationId }),
  });
  if (!selected.response.ok) {
    throw new Error(`Primary organization restore failed: HTTP ${selected.response.status} ${selected.text.slice(0, 500)}`);
  }
}

async function renameProvisionedOrganization(provisioned: ProvisionedOrg, name: string): Promise<void> {
  const renamed = await denFetch(provisioned.admin, "/v1/org", {
    method: "PATCH",
    headers: auth(provisioned.admin.token),
    body: JSON.stringify({ name }),
  });
  if (!renamed.response.ok) {
    throw new Error(`Organization rename to ${JSON.stringify(name)} failed: HTTP ${renamed.response.status} ${renamed.text.slice(0, 500)}`);
  }
}

async function deleteProvisionedOrganization(provisioned: ProvisionedOrg): Promise<void> {
  const active = await freshSession(provisioned.admin).catch(() => provisioned.admin);
  const selected = await denFetch(active, "/v1/me/active-organization", {
    method: "POST",
    headers: auth(active.token),
    body: JSON.stringify({ organizationId: provisioned.orgId }),
  });
  if (selected.response.status === 404) return;
  if (!selected.response.ok) {
    throw new Error(`Organization cleanup selection returned HTTP ${selected.response.status}: ${selected.text.slice(0, 500)}`);
  }
  const deleted = await denFetch(active, "/v1/org", {
    method: "DELETE",
    headers: auth(active.token),
  });
  if (!deleted.response.ok && deleted.response.status !== 404) {
    throw new Error(`Organization cleanup returned HTTP ${deleted.response.status}: ${deleted.text.slice(0, 500)}`);
  }
}

function emailSegment(value: string): string {
  const segment = [...value.toLowerCase()]
    .map((character) => /[a-z0-9]/.test(character) ? character : "-")
    .join("")
    .replace(/^-+|-+$/g, "");
  return segment || "member";
}

function extraOrganizationMembers(
  worldName: string,
  orgName: string,
  org: WorldOrg,
): string[] {
  const members = new Set<string>();
  for (const [memberName, person] of Object.entries(org.members ?? {})) {
    members.add(
      person.email?.trim()
      || `${emailSegment(memberName)}+${emailSegment(worldName)}-${emailSegment(orgName)}@openwork.test`,
    );
  }
  return [...members];
}

function witnessMocks(topology: WorldTopology) {
  return Object.fromEntries(
    Object.entries(topology.witnesses ?? {}).flatMap(([name, witness]) => witness.kind === "mcp"
      ? [[
          name,
          mcpMock({
            allowUnauthenticatedMcp: witness.allowUnauthenticatedMcp,
            profileId: witness.profileId,
            fault: witness.fault,
          }),
        ]]
      : []),
  );
}

async function kindDen(): Promise<Den> {
  await ensureKindDenReady();
  const endpoints = await exposeEndpointHandles(kubeProfileConfig("single-org"));
  const ref: DenRef = { apiUrl: endpoints.apiUrl, webUrl: endpoints.webUrl };
  try {
    const admin: DenSession = {
      ...ref,
      token: endpoints.token,
      email: endpoints.adminEmail,
      password: DEMO_PASSWORD,
    };
    let disposed = false;
    return {
      ref,
      admin,
      members: {},
      mocks: {},
      async apiLog(): Promise<string> {
        throw new Error(
          "den.apiLog() is not available for kind worlds; read the shared den-api deployment logs with kubectl.",
        );
      },
      async [Symbol.asyncDispose](): Promise<void> {
        if (disposed) return;
        disposed = true;
        // The kind cluster is shared developer infrastructure; a world owns only its port-forwards.
        await endpoints.stop();
      },
    };
  } catch (error) {
    await endpoints.stop();
    throw error;
  }
}

function resolvedApps(
  apps: Record<string, App>,
  seededTitles: Record<string, string[]>,
): WorldSnapshotResolved["apps"] {
  const resolved: WorldSnapshotResolved["apps"] = {};
  for (const [name, booted] of Object.entries(apps)) {
    const workspaceId = booted.snapshotWorkspaceId === undefined
      ? booted.workspaceId
      : booted.snapshotWorkspaceId;
    resolved[name] = {
      cdpUrl: booted.handle.cdpUrl,
      workspaceId,
      sessions: seededTitles[name],
      ...(booted.handle.pid && booted.handle.profileDir
        ? { owner: { pid: booted.handle.pid, profileDir: booted.handle.profileDir } }
        : {}),
    };
  }
  return resolved;
}

export function buildSnapshot(input: BuildSnapshotInput): WorldSnapshot {
  const topology = defineWorld(input.topology).topology;
  const snapshot: WorldSnapshot = worldSnapshotSchema.parse({
    version: 1,
    name: input.name,
    createdAt: input.createdAt ?? new Date().toISOString(),
    place: input.place,
    topology: snapshotTopology(topology),
    resolved: input.resolved,
  });
  if (snapshot.resolved.den.origin !== "none" && snapshot.resolved.den.database !== undefined) {
    validateDatabaseName(snapshot.resolved.den.database);
  }
  return snapshot;
}

/** Snapshot files cross artifact, bug-report, and chat boundaries; unlike in-code topologies, they are hostile input. */
export function parseUntrustedSnapshot(jsonText: string): WorldSnapshot {
  const { snapshot } = parseSnapshotStructure(jsonText);
  validateUntrustedSnapshot(snapshot);
  return snapshot;
}

function rejectAttachedSnapshotOperation(snapshot: WorldSnapshot): void {
  if (snapshot.topology.den.attach || snapshot.resolved.den.origin === "attached") {
    throw new Error(
      "Attached worlds cannot be resumed or rebuilt from snapshots: snapshots are untrusted input and attached Dens receive credentials. Re-run the code-defined topology instead.",
    );
  }
}

function rejectSecretRefSnapshotOperation(snapshot: WorldSnapshot): void {
  const hasSecretRef = Object.values(snapshot.topology.den.orgs).some((org) =>
    org.admin?.secretRef !== undefined
    || Object.values(org.members ?? {}).some((member) => member.secretRef !== undefined)
  );
  if (hasSecretRef) {
    throw new Error(
      "Snapshots naming secretRef people cannot be resumed or rebuilt: snapshots are untrusted input and must never select environment credentials. Re-run the code-defined topology instead.",
    );
  }
}

function rejectUnsafeSnapshotOperation(snapshot: WorldSnapshot): void {
  rejectAttachedSnapshotOperation(snapshot);
  rejectSecretRefSnapshotOperation(snapshot);
}

export function fromSnapshot(jsonText: string): { topology: WorldTopology; name: string } {
  const snapshot = parseUntrustedSnapshot(jsonText);
  rejectUnsafeSnapshotOperation(snapshot);
  return {
    topology: defineWorld(snapshot.topology).topology,
    name: snapshot.name,
  };
}

async function requireRunningWorld(snapshot: WorldSnapshot): Promise<void> {
  if (snapshot.resolved.den.origin === "none") return;
  const url = `${snapshot.resolved.den.apiUrl.replace(/\/+$/, "")}/health`;
  let last = "not attempted";
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = messageText(error);
    }
    if (attempt < 5) await delay(500);
  }
  throw new Error(`world is not running: Den health check failed at ${url} (${last}).`);
}

function localUrlPort(value: string): number | null {
  try {
    const url = new URL(value);
    if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) return null;
    const port = Number(url.port);
    return Number.isInteger(port) && port >= 1024 && port <= 65_535 ? port : null;
  } catch {
    return null;
  }
}

async function dropSnapshotDatabase(name: string): Promise<void> {
  const connection = await createConnection(DEFAULT_LOCAL_MYSQL_URL);
  try {
    await connection.query(`DROP DATABASE IF EXISTS \`${name}\``);
  } finally {
    await connection.end();
  }
}

export async function resumeWorld(
  snapshotJsonText: string,
  options: { teardown?: boolean } = {},
): Promise<ResumedWorld> {
  const snapshot = parseUntrustedSnapshot(snapshotJsonText);
  rejectUnsafeSnapshotOperation(snapshot);
  const topology = defineWorld(snapshot.topology).topology;
  const sharedProductionState = usesLiveSharedProductionState(topology);
  await requireRunningWorld(snapshot);
  let ref: DenRef;
  let admin: DenSession;
  if (sharedProductionState) {
    ref = { apiUrl: "", webUrl: "" };
    admin = { ...ref, token: "", email: "", password: "" };
  } else {
    if (snapshot.resolved.den.origin === "none") {
      throw new Error("World snapshot has no Den but its topology is not a live-shared installed-production desktop world.");
    }
    const [, primaryOrg] = primaryOrganization(topology);
    const adminPerson = topology.den.seed === "demo-org"
      ? defaultReuseAdmin()
      : personDefaults("admin", primaryOrg.admin, emailSegment(snapshot.name));
    ref = {
      apiUrl: snapshot.resolved.den.apiUrl,
      webUrl: snapshot.resolved.den.webUrl,
    };
    admin = await signIn(ref, { email: adminPerson.email, password: adminPerson.password });
  }
  const apps: Record<string, DesktopHandle> = {};
  if (options.teardown !== true) {
    for (const [name, resolved] of Object.entries(snapshot.resolved.apps)) {
      try {
        apps[name] = await desktop({
          name: `world-resume-${name}`,
          mode: "attach",
          cdpUrl: resolved.cdpUrl,
          timeoutMs: 10_000,
        });
      } catch (error) {
        console.warn(`[openwork/testkit] World app ${JSON.stringify(name)} could not be attached during resume: ${messageText(error)}`);
      }
    }
  }

  let detached = false;
  const detach = async (): Promise<void> => {
    if (detached) return;
    detached = true;
    for (const [name, app] of Object.entries(apps)) {
      await app.stop().catch((error: unknown) => {
        console.error(`[openwork/testkit] World app ${JSON.stringify(name)} CDP detach failed: ${messageText(error)}`);
      });
    }
  };

  let teardownResult: WorldTeardownResult | null = null;
  const teardown = async (): Promise<WorldTeardownResult> => {
    if (teardownResult) return teardownResult;
    await detach();
    const stoppedApps: string[] = [];
    for (const [name, resolved] of Object.entries(snapshot.resolved.apps)) {
      if (sharedProductionState && resolved.owner) {
        await stopOwnedElectronSurface(resolved.owner.pid, resolved.owner.profileDir)
          .then(() => stoppedApps.push(name))
          .catch((error: unknown) => {
            console.error(`[openwork/testkit] World app ${JSON.stringify(name)} owned teardown failed: ${messageText(error)}`);
          });
        continue;
      }
      const port = localUrlPort(resolved.cdpUrl);
      if (port === null) continue;
      await freePort(port)
        .then(() => stoppedApps.push(name))
        .catch((error: unknown) => {
          console.error(`[openwork/testkit] World app ${JSON.stringify(name)} teardown failed on CDP port ${port}: ${messageText(error)}`);
        });
    }

    const stoppedDenPorts: number[] = [];
    if (snapshot.resolved.den.origin === "launched") {
      const denPortCandidates: number[] = [];
      if (snapshot.resolved.den.ports) {
        denPortCandidates.push(snapshot.resolved.den.ports.api, snapshot.resolved.den.ports.web);
      } else {
        const apiPort = localUrlPort(snapshot.resolved.den.apiUrl);
        const webPort = localUrlPort(snapshot.resolved.den.webUrl);
        if (apiPort !== null) denPortCandidates.push(apiPort);
        if (webPort !== null) denPortCandidates.push(webPort);
      }
      for (const port of new Set(denPortCandidates)) {
        await freePort(port)
          .then(() => stoppedDenPorts.push(port))
          .catch((error: unknown) => {
            console.error(`[openwork/testkit] World Den teardown failed on port ${port}: ${messageText(error)}`);
          });
      }
    }

    let droppedDatabase: string | undefined;
    const database = snapshot.resolved.den.origin === "launched"
      ? snapshot.resolved.den.database
      : undefined;
    if (snapshot.place === "local" && database) {
      await dropSnapshotDatabase(database)
        .then(() => { droppedDatabase = database; })
        .catch((error: unknown) => {
          console.error(`[openwork/testkit] World database ${database} teardown failed: ${messageText(error)}`);
        });
    }
    teardownResult = {
      denPorts: stoppedDenPorts,
      apps: stoppedApps,
      ...(droppedDatabase === undefined ? {} : { database: droppedDatabase }),
    };
    return teardownResult;
  };

  return {
    name: snapshot.name,
    den: { ref, admin },
    apps,
    detach,
    teardown,
  };
}

function worldTopology(definition: WorldDefinition | WorldTopology): WorldTopology {
  return defineWorld("topology" in definition ? definition.topology : definition).topology;
}

function disabledDen(): Den {
  const ref: DenRef = { apiUrl: "", webUrl: "" };
  return {
    ref,
    admin: { ...ref, token: "", email: "", password: "" },
    members: {},
    mocks: {},
    async apiLog(): Promise<string> {
      throw new Error("This desktop-only world does not run a Den.");
    },
    async [Symbol.asyncDispose](): Promise<void> {},
  };
}

export interface StartWorldOptions {
  place?: Place;
  name?: string;
  allowSharedState?: boolean;
  resolveInstalledProductionState?: () => Promise<InstalledProductionDesktopState>;
}

export async function startWorld(
  definition: WorldDefinition | WorldTopology,
  options: StartWorldOptions = {},
): Promise<World> {
  const topology = worldTopology(definition);
  const resolvedOrganizations = resolveOrganizationMap(topology.den.orgs, process.env);
  const place = options.place ?? resolvePlace(process.env);
  const sharedProductionState = usesLiveSharedProductionState(topology);
  if (sharedProductionState && options.allowSharedState !== true) {
    throw new Error("Refusing LIVE SHARED PRODUCTION STATE launch without explicit --allow-shared-state opt-in.");
  }
  if (sharedProductionState && place.kind !== "local") {
    throw new Error("LIVE SHARED PRODUCTION STATE requires local placement; remote and Daytona placement are refused.");
  }
  if (topology.den.substrate === "kind" && place.kind !== "local") {
    throw new Error('den.substrate "kind" requires local placement because the kind cluster and its port-forwards run on the local Docker host.');
  }
  const name = options.name ?? `world-${Date.now().toString(36)}-${process.pid.toString(36)}`;
  if (!SNAPSHOT_NAME.test(name)) {
    throw new Error("World names must use only letters, numbers, dots, underscores, and hyphens.");
  }
  const primary = Object.entries(resolvedOrganizations)[0];
  const primaryOrgName = primary?.[0];
  const primaryOrg = primary?.[1];
  const scope = await Effect.runPromise(Scope.make("sequential"));

  const acquisition = Effect.gen(function*() {
    const gateways: Record<string, LiteLlmHandle> = {};
    for (const [witnessName, witness] of Object.entries(topology.witnesses ?? {})) {
      if (witness.kind !== "litellm") continue;
      gateways[witnessName] = yield* Effect.acquireRelease(
        Effect.promise(() => liteLlm({
          place,
          modelId: witness.modelId,
          reply: witness.reply,
          database: true,
          maxInputTokens: witness.maxInputTokens,
          maxOutputTokens: witness.maxOutputTokens,
        })),
        (gateway) => Effect.promise(() => gateway[Symbol.asyncDispose]()),
      );
    }
    const den = yield* Effect.acquireRelease(
      Effect.promise(() => sharedProductionState
        ? Promise.resolve(disabledDen())
        : topology.den.substrate === "kind"
        ? kindDen()
        : server({
            place,
            ...(primaryOrgName === undefined || primaryOrg === undefined
              ? {}
              : {
                  org: {
                    name: primaryOrgName,
                    admin: topology.den.attach
                      ? primaryOrg.admin
                      : topology.den.seed === "demo-org"
                        ? primaryOrg.admin
                        : personDefaults("admin", primaryOrg.admin, emailSegment(name)),
                    members: primaryOrg.members,
                  },
                }),
            provision: topology.den.seed === "demo-org" || topology.den.attach?.tier === "prod" ? false : undefined,
            web: topology.den.web,
            env: topology.den.env,
            mocks: witnessMocks(topology),
            ports: topology.den.ports,
            seedProfile: topology.den.seed,
            reuse: topology.den.attach === undefined
              ? undefined
              : { apiUrl: topology.den.attach.apiUrl, webUrl: topology.den.attach.webUrl },
          })),
      (booted) => Effect.promise(() => booted[Symbol.asyncDispose]()),
    );
    const llmProviders: Record<string, WorldLlmProviderRuntime> = {};
    if (
      primaryOrgName !== undefined
      && primaryOrg !== undefined
      && !sharedProductionState
      && topology.den.substrate !== "kind"
      && topology.den.seed !== "demo-org"
    ) {
      const primaryOrganizationId = yield* Effect.promise(() => organizationIdByName(den.admin, primaryOrgName));

      for (const [orgName, org] of Object.entries(resolvedOrganizations).slice(1)) {
        const provisioned = yield* Effect.acquireRelease(
          Effect.promise(() => provisionOrg(den.ref, {
            members: extraOrganizationMembers(name, orgName, org),
          })),
          (created) => Effect.promise(() => deleteProvisionedOrganization(created).catch((error: unknown) => {
            console.error(`[openwork/testkit] world org ${orgName} cleanup failed: ${messageText(error)}`);
          })),
        );
        yield* Effect.promise(() => renameProvisionedOrganization(provisioned, orgName));
        yield* Effect.promise(() => addPrimaryAdminToOrganization(provisioned, den.admin, primaryOrganizationId));
      }

      // Local/Daytona DBs are ephemeral; attached-Den reuse can leak rows not covered by organization deletion.
      Object.assign(
        llmProviders,
        yield* Effect.promise(() => realizePrimaryOrganizationContent(
          den,
          primaryOrganizationId,
          primaryOrg,
          topology,
          gateways,
        )),
      );
    }

    const apps: Record<string, App> = {};
    const seededTitles: Record<string, string[]> = {};
    let installedProductionState: InstalledProductionDesktopState | null = null;
    for (const [appName, appDefinition] of Object.entries(topology.apps ?? {})) {
      const booted = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          if (appDefinition.desktopState?.mode === "live-shared") {
            installedProductionState ??= await (
              options.resolveInstalledProductionState ?? resolveInstalledProductionDesktopState
            )();
            return liveSharedProductionApp({
              host: localHost(),
              name: `world-${name}-${appName}`,
              state: installedProductionState,
            });
          }
          return bootApp({
            den,
            place,
            workspacePath: appDefinition.workspacePath,
            model: appDefinition.model,
            localServerDelayMs: appDefinition.localServerDelayMs,
            ...(appDefinition.signedInTo
              ? { as: appDefinition.signedInTo.as }
              : { signIn: false }),
          });
        }),
        (running) => Effect.promise(() => running[Symbol.asyncDispose]()),
      );
      apps[appName] = booted;
      const declaredSessions = appDefinition.sessions;
      seededTitles[appName] = declaredSessions === undefined
        ? []
        : (yield* Effect.promise(() => seedSessions(booted, declaredSessions))).map((session) => session.title);
    }

    const snapshotPath = join(WORLDS_DIR, `${name}.json`);
    const snapshot = buildSnapshot({
      name,
      place: place.kind,
      topology,
      resolved: {
        den: sharedProductionState
          ? { origin: "none" }
          : {
              ...den.ref,
              origin: topology.den.attach ? "attached" : "launched",
              ...(topology.den.substrate === "kind" ? { substrate: "kind" } : {}),
              ...(den.database ? { database: den.database.name } : {}),
              ...(den.ports ? { ports: den.ports } : {}),
            },
        apps: resolvedApps(apps, seededTitles),
      },
    });
    yield* Effect.promise(async () => {
      await mkdir(WORLDS_DIR, { recursive: true });
      await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await chmod(snapshotPath, 0o600);
    });
    return { den, apps, llmProviders, snapshotPath };
  });

  try {
    const acquired = await Effect.runPromise(Scope.provide(acquisition, scope));
    let disposed = false;
    return {
      name,
      topology,
      den: acquired.den,
      apps: acquired.apps,
      llmProviders: acquired.llmProviders,
      app(appName) {
        const found = acquired.apps[appName];
        if (!found) {
          throw new Error(`Unknown world app ${JSON.stringify(appName)}. Available: ${Object.keys(acquired.apps).join(", ") || "(none)"}`);
        }
        return found;
      },
      snapshotPath: acquired.snapshotPath,
      async [Symbol.asyncDispose](): Promise<void> {
        if (disposed) return;
        disposed = true;
        await Effect.runPromise(Scope.close(scope, Exit.void));
      },
    };
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.die(error))).catch((cleanupError: unknown) => {
      console.error(`[openwork/testkit] world cleanup after acquisition failure failed: ${messageText(cleanupError)}`);
    });
    throw error;
  }
}
