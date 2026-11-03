#!/usr/bin/env node
// Explicit operator action, not a deployer: preview by default, PATCH only buildFilter.
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildInputPatterns } from "./build-inputs.mjs";

const API = "https://api.render.com/v1";
const REPOSITORY = "https://github.com/different-ai/openwork";
const BRANCH = "dev";
const PAGE_SIZE = 100;
export const RENDER_SERVICES = Object.freeze({
  "api-private": { target: "native-den-api", runtime: "node" },
  "inference-private": { target: "native-inference", runtime: "node" },
  workbot: { target: "native-workbot", runtime: "node" },
  "client-web": { target: "client-web", runtime: "docker" },
});

function serviceNames(service) {
  if (service === "all") return Object.keys(RENDER_SERVICES);
  if (!Object.hasOwn(RENDER_SERVICES, service)) throw new Error("Select all or one of the four allowlisted Render service names.");
  return [service];
}

function canonicalFilter(filter) {
  if (filter === undefined || filter === null) return { paths: [], ignoredPaths: [] };
  if (!Array.isArray(filter.paths) || !Array.isArray(filter.ignoredPaths)
    || [...filter.paths, ...filter.ignoredPaths].some((path) => typeof path !== "string")) {
    throw new Error("Render returned an invalid buildFilter; refusing to guess its current value.");
  }
  return {
    paths: [...new Set(filter.paths)].sort(),
    ignoredPaths: [...new Set(filter.ignoredPaths)].sort(),
  };
}

const sameFilter = (left, right) => JSON.stringify(canonicalFilter(left)) === JSON.stringify(canonicalFilter(right));

/** No parallel path list: Render consumes the same versioned build boundaries as CI. */
export function renderBuildFilter(service, options = {}) {
  if (!Object.hasOwn(RENDER_SERVICES, service)) throw new Error("Unknown Render service name.");
  const paths = buildInputPatterns(RENDER_SERVICES[service].target, options);
  if (!paths.length || paths.some((path) => typeof path !== "string" || !path.length || path.startsWith("/") || path.split("/").includes(".."))) {
    throw new Error("Build inputs must be nonempty repository-relative include patterns.");
  }
  return canonicalFilter({ paths, ignoredPaths: [] });
}

function assertService(service, name, ownerId, expectedId) {
  const fail = (reason) => { throw new Error(`Refusing ${name}: ${reason}.`); };
  if (!service || typeof service.id !== "string" || !/^srv-[a-z0-9]+$/.test(service.id)) fail("invalid service identity");
  if (expectedId && service.id !== expectedId) fail("service identity changed after discovery");
  if (service.name !== name || service.ownerId !== ownerId) fail("name or workspace does not match");
  if (service.repo !== REPOSITORY || service.branch !== BRANCH) fail("repository or dev branch does not match");
  if (service.suspended !== "not_suspended") fail("service is not active");
  if (service.rootDir !== "" && service.rootDir !== ".") fail("rootDir must be the repository root; it will not be changed");
  if (service.buildSourceId) fail("a shared Build Source requires a new input audit");
  const details = service.serviceDetails;
  if ((details?.runtime ?? details?.env) !== RENDER_SERVICES[name].runtime) fail("runtime does not match the audited build inputs");
  if (name === "client-web") {
    const docker = details.envSpecificDetails;
    if (docker?.dockerfilePath?.replace(/^\.\//, "") !== "packaging/docker/Dockerfile.den-gateway"
      || !["", ".", "./"].includes(docker?.dockerContext)) {
      fail("source Docker recipe or context does not match the audited client build");
    }
  }
}

/** Inject fetch/log for offline tests; neither API origin nor service identities are operator-controlled. */
export async function runRenderBuildFilters({
  ownerId,
  apiKey,
  service = "all",
  apply = false,
  githubRef = process.env.GITHUB_REF,
  githubRepository = process.env.GITHUB_REPOSITORY,
  root,
  ref,
  fetchImpl = globalThis.fetch,
  log = console.log,
} = {}) {
  const names = serviceNames(service);
  if (typeof apply !== "boolean") throw new Error("apply must be an explicit boolean; preview is the default.");
  if (apply && (githubRef !== "refs/heads/dev" || githubRepository !== "different-ai/openwork")) {
    throw new Error("Apply is allowed only from different-ai/openwork on refs/heads/dev.");
  }
  if (typeof ownerId !== "string" || !/^(tea|usr)-[a-z0-9]+$/.test(ownerId)) {
    throw new Error("A Render workspace/owner ID is required (tea-… or usr-…); obtain it from workspace settings.");
  }
  if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("RENDER_API_KEY is required; supply it through the protected environment, not workflow inputs.");

  // Never log service responses, request URLs, headers, commands, or provider error bodies.
  const privateValues = [apiKey, ownerId];
  const emit = (record) => log(JSON.stringify(record, (_key, value) => typeof value === "string"
    ? privateValues.reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), value)
    : value, 2));
  const request = async (method, path, label, body) => {
    let response;
    try {
      response = await fetchImpl(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error(`Render ${method} ${label} failed (network, timeout, or redirect). An apply may be partial; preview before retrying.`);
    }
    if (!response.ok) throw new Error(`Render ${method} ${label} failed (HTTP ${response.status}). An apply may be partial; preview before retrying.`);
    try { return await response.json(); }
    catch { throw new Error(`Render ${method} ${label} returned invalid JSON. An apply may be partial; preview before retrying.`); }
  };

  const services = [];
  let cursor;
  const cursors = new Set();
  for (let page = 0; ; page += 1) {
    if (page >= 100) throw new Error("Render service pagination exceeded its safety limit; no writes attempted.");
    const query = new URLSearchParams({ ownerId, limit: String(PAGE_SIZE), includePreviews: "false" });
    if (cursor) query.set("cursor", cursor);
    const entries = await request("GET", `/services?${query}`, "list services");
    if (!Array.isArray(entries) || entries.some((entry) => !entry?.service || typeof entry.service !== "object")) {
      throw new Error("Render returned an invalid service list; no writes attempted.");
    }
    services.push(...entries.map((entry) => entry.service));
    if (entries.length < PAGE_SIZE) break;
    cursor = entries.at(-1).cursor;
    if (typeof cursor !== "string" || !cursor || cursors.has(cursor)) throw new Error("Render returned an invalid pagination cursor; no writes attempted.");
    cursors.add(cursor);
  }

  // Resolve and read *every* selected service before the first write. Never match substrings.
  const selected = names.map((name) => {
    const matches = services.filter((item) => item.name === name);
    if (matches.length !== 1) throw new Error(`Expected exactly one ${name} in the selected workspace; found ${matches.length}. No writes attempted.`);
    const match = matches[0];
    assertService(match, name, ownerId);
    privateValues.push(match.id);
    return match;
  });
  const readService = async (item) => {
    const current = await request("GET", `/services/${item.id}`, `service ${item.name}`);
    assertService(current, item.name, ownerId, item.id);
    return current;
  };
  const plan = [];
  for (const item of selected) {
    const current = await readService(item);
    const before = canonicalFilter(current.buildFilter);
    const desired = renderBuildFilter(item.name, { root, ref });
    plan.push({ item, before, desired, changed: !sameFilter(before, desired) });
  }
  emit({
    event: "render-build-filters.plan",
    mode: apply ? "apply" : "preview",
    repository: REPOSITORY,
    branch: BRANCH,
    redeploy: false,
    services: plan.map(({ item, before, desired, changed }) => ({
      name: item.name,
      target: RENDER_SERVICES[item.name].target,
      action: changed ? (apply ? "patch" : "would_patch") : "noop",
      before,
      desired,
    })),
  });

  const results = [];
  for (const { item, before, desired, changed } of plan) {
    let action = changed ? "would_patch" : "noop";
    if (apply && changed) {
      const latest = canonicalFilter((await readService(item)).buildFilter);
      if (sameFilter(latest, desired)) action = "noop";
      else {
        if (!sameFilter(latest, before)) throw new Error(`Refusing ${item.name}: buildFilter changed after planning. Preview again before applying.`);
        // Minimal PATCH preserves rootDir, autodeploy, build/start commands, secrets and all other settings.
        // Do not retry an uncertain PATCH, create services, or call a deploy endpoint.
        await request("PATCH", `/services/${item.id}`, `service ${item.name}`, { buildFilter: desired });
        if (!sameFilter((await readService(item)).buildFilter, desired)) {
          throw new Error(`Render did not retain the desired filter for ${item.name}; preview before retrying.`);
        }
        action = "applied";
      }
    }
    results.push({ name: item.name, action });
    if (apply) emit({ event: "render-build-filters.result", name: item.name, action });
  }
  const result = { event: "render-build-filters.complete", mode: apply ? "apply" : "preview", services: results, redeploy: false };
  emit(result);
  return result;
}

async function main() {
  const apply = process.env.RENDER_APPLY ?? "false";
  if (apply !== "true" && apply !== "false") throw new Error("RENDER_APPLY must be exactly true or false.");
  await runRenderBuildFilters({
    ownerId: process.env.RENDER_OWNER_ID,
    apiKey: process.env.RENDER_API_KEY,
    service: process.env.RENDER_SERVICE ?? "all",
    apply: apply === "true",
    log: (message) => {
      console.log(message);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n\`\`\`json\n${message}\n\`\`\`\n`);
    },
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // Errors above use fixed descriptions, never a Render response body or fetch error/cause.
    const message = [process.env.RENDER_API_KEY, process.env.RENDER_OWNER_ID].filter(Boolean)
      .reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), error.message);
    console.error(message);
    process.exitCode = 1;
  });
}
