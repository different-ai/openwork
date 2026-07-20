#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FAILED_DEPLOY_STATUSES = new Set([
  "build_failed",
  "update_failed",
  "pre_deploy_failed",
  "canceled",
  "deactivated",
]);

function required(value, name) {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${name} is required`);
  }
  return normalized;
}

export function releaseVersionFromTag(tag) {
  const normalized = required(tag, "Git tag");
  const match = normalized.match(
    /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/,
  );
  if (!match) {
    throw new Error(`Release tag must be valid semver prefixed with v: ${normalized}`);
  }
  return match[1];
}

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, "");
}

function createRenderClient({ apiBase, apiKey, fetchImpl }) {
  const baseUrl = normalizeBaseUrl(apiBase);

  return async function renderRequest(path, init = {}) {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    const body = await response.text();
    const payload = body ? JSON.parse(body) : null;
    if (!response.ok) {
      throw new Error(
        `Render API ${init.method ?? "GET"} ${path} failed (${response.status}): ${body.slice(0, 400)}`,
      );
    }
    return payload;
  };
}

async function findDirectVersion({ renderRequest, serviceId }) {
  let cursor = null;

  do {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const rows = await renderRequest(
      `/services/${encodeURIComponent(serviceId)}/env-vars?${query}`,
    );
    const match = rows.find((row) => row?.envVar?.key === "DEN_API_VERSION");
    if (match) {
      return { exists: true, value: match.envVar.value };
    }
    cursor = rows.length === 100 ? rows.at(-1)?.cursor ?? null : null;
  } while (cursor);

  return { exists: false, value: null };
}

async function setVersion({ renderRequest, serviceId, value }) {
  await renderRequest(
    `/services/${encodeURIComponent(serviceId)}/env-vars/DEN_API_VERSION`,
    {
      method: "PUT",
      body: JSON.stringify({ value }),
    },
  );
}

async function restoreVersion({ renderRequest, serviceId, previousVersion }) {
  if (previousVersion.exists) {
    await setVersion({
      renderRequest,
      serviceId,
      value: previousVersion.value,
    });
    return;
  }

  await renderRequest(
    `/services/${encodeURIComponent(serviceId)}/env-vars/DEN_API_VERSION`,
    { method: "DELETE" },
  );
}

async function waitForDeploy({
  renderRequest,
  serviceId,
  deployId,
  sleep,
  pollIntervalMs,
  maxDeployPolls,
  log,
}) {
  for (let attempt = 1; attempt <= maxDeployPolls; attempt += 1) {
    const deploy = await renderRequest(
      `/services/${encodeURIComponent(serviceId)}/deploys/${encodeURIComponent(deployId)}`,
    );
    log(`Render deploy ${deployId}: ${deploy.status}`);
    if (deploy.status === "live") return;
    if (FAILED_DEPLOY_STATUSES.has(deploy.status)) {
      throw new Error(`Render deploy ${deployId} failed with status ${deploy.status}`);
    }
    if (attempt < maxDeployPolls) await sleep(pollIntervalMs);
  }

  throw new Error(`Render deploy ${deployId} did not go live in time`);
}

async function waitForReleaseHealth({
  serviceUrl,
  version,
  fetchImpl,
  sleep,
  healthPollIntervalMs,
  maxHealthPolls,
}) {
  const healthUrl = new URL("/health", `${normalizeBaseUrl(serviceUrl)}/`);
  let lastResult = "no response";

  for (let attempt = 1; attempt <= maxHealthPolls; attempt += 1) {
    try {
      const response = await fetchImpl(healthUrl);
      const body = await response.text();
      lastResult = `HTTP ${response.status}: ${body.slice(0, 400)}`;
      if (response.ok) {
        const payload = JSON.parse(body);
        if (
          payload?.ok === true &&
          payload?.service === "den-api" &&
          payload?.version === version
        ) {
          return;
        }
      }
    } catch (error) {
      lastResult = error instanceof Error ? error.message : String(error);
    }
    if (attempt < maxHealthPolls) await sleep(healthPollIntervalMs);
  }

  throw new Error(
    `Den API health did not report release ${version}: ${lastResult}`,
  );
}

export async function deployDenApiTag({
  tag,
  commitSha,
  apiKey,
  serviceId,
  apiBase = "https://api.render.com/v1",
  fetchImpl = globalThis.fetch,
  sleep = (milliseconds) =>
    new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
  pollIntervalMs = 10_000,
  maxDeployPolls = 90,
  healthPollIntervalMs = 5_000,
  maxHealthPolls = 12,
  log = console.log,
}) {
  const version = releaseVersionFromTag(tag);
  const commit = required(commitSha, "Git commit SHA");
  if (!/^[a-f0-9]{40,64}$/i.test(commit)) {
    throw new Error(`Git commit SHA is invalid: ${commit}`);
  }

  const renderApiKey = required(apiKey, "RENDER_API_KEY");
  const renderServiceId = required(serviceId, "RENDER_DEN_CONTROL_PLANE_SERVICE_ID");
  const renderRequest = createRenderClient({
    apiBase: required(apiBase, "RENDER_API_BASE"),
    apiKey: renderApiKey,
    fetchImpl,
  });

  const service = await renderRequest(
    `/services/${encodeURIComponent(renderServiceId)}`,
  );
  if (!service.repo || service.imagePath) {
    throw new Error("The Den API Render service must be Git-backed");
  }
  if (service.serviceDetails?.runtime !== "docker") {
    throw new Error("The Den API Render service must build from its Dockerfile");
  }
  const serviceUrl = required(
    service.serviceDetails?.url,
    "Den API Render service URL",
  );

  const previousVersion = await findDirectVersion({
    renderRequest,
    serviceId: renderServiceId,
  });
  let versionStaged = false;

  try {
    await setVersion({
      renderRequest,
      serviceId: renderServiceId,
      value: version,
    });
    versionStaged = true;
    log(`Staged Den API release version ${version}.`);

    const deploy = await renderRequest(
      `/services/${encodeURIComponent(renderServiceId)}/deploys`,
      {
        method: "POST",
        body: JSON.stringify({ commitId: commit }),
      },
    );
    const deployId = required(deploy?.id, "Render deploy ID");
    log(`Triggered Render deploy ${deployId} for ${commit}.`);

    await waitForDeploy({
      renderRequest,
      serviceId: renderServiceId,
      deployId,
      sleep,
      pollIntervalMs,
      maxDeployPolls,
      log,
    });
    await waitForReleaseHealth({
      serviceUrl,
      version,
      fetchImpl,
      sleep,
      healthPollIntervalMs,
      maxHealthPolls,
    });
    log(`Den API is live and reports release ${version}.`);

    return { deployId, version };
  } finally {
    if (versionStaged) {
      await restoreVersion({
        renderRequest,
        serviceId: renderServiceId,
        previousVersion,
      });
      log("Restored the Den API version setting for future non-release deploys.");
    }
  }
}

async function main() {
  if (process.env.GITHUB_REF_TYPE !== "tag") {
    throw new Error("This command only deploys Git tag refs");
  }

  await deployDenApiTag({
    tag: process.env.GITHUB_REF_NAME,
    commitSha: process.env.GITHUB_SHA,
    apiKey: process.env.RENDER_API_KEY,
    serviceId: process.env.RENDER_SERVICE_ID,
    apiBase: process.env.RENDER_API_BASE,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
