import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "den-download-link-match-allowed-versions";
const DEN_API_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_DEN_API_URL);
const DEN_TOKEN = process.env.OPENWORK_EVAL_DEN_TOKEN?.trim() || "";
const MEMBER_TOKEN = process.env.OPENWORK_EVAL_MEMBER_DEN_TOKEN?.trim() || DEN_TOKEN;
const DEFAULT_RELEASE_TAG = process.env.OPENWORK_EVAL_DEFAULT_INSTALLER_RELEASE_TAG?.trim() || "v0.17.28";
const DEFAULT_RELEASE_VERSION = DEFAULT_RELEASE_TAG.replace(/^v/i, "");
const ALLOWED_VERSIONS = ["0.17.26", "0.17.27"];
const SELECTED_VERSION = "0.17.27";
const DISALLOWED_VERSION = "0.17.28";

// Narration is loaded from the approved script (evals/voiceovers/den-download-link-match-allowed-versions.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const state = {
  organizationId: null,
  organizationName: null,
  memberInstallToken: null,
  restrictedDownload: null,
  unrestrictedInstallToken: null,
  unrestrictedDownload: null,
};

function cleanBaseUrl(value) {
  return (value ?? "").trim().replace(/\/+$/, "");
}

function witness(ctx, condition, assertion, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual: actual === undefined ? undefined : typeof actual === "string" ? actual : JSON.stringify(actual).slice(0, 900),
  });
  ctx.assert(condition, `${assertion}${actual === undefined ? "" : ` (actual: ${JSON.stringify(actual).slice(0, 500)})`}`);
}

function readOrganizationMetadata(organization) {
  const metadata = organization?.metadata;
  if (metadata && typeof metadata === "object") return metadata;
  if (typeof metadata !== "string") return {};
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function denApiFetch(path, options = {}) {
  const { auth, token, ...fetchOptions } = options;
  const headers = new Headers(options.headers ?? {});
  headers.set("accept", "application/json");
  if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (auth !== false) headers.set("authorization", `Bearer ${token ?? DEN_TOKEN}`);

  const response = await fetch(`${DEN_API_URL}${path}`, { ...fetchOptions, headers });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { response, body, text };
}

async function ensureOrganization(ctx) {
  if (state.organizationId) return;
  const orgs = await denApiFetch("/v1/me/orgs");
  witness(ctx, orgs.response.ok, "The signed-in Den user can list their organizations", { status: orgs.response.status, body: orgs.body });
  const organizations = Array.isArray(orgs.body?.orgs) ? orgs.body.orgs : [];
  const active = organizations.find((organization) => organization?.id === orgs.body?.activeOrgId) ?? organizations[0];
  witness(ctx, typeof active?.id === "string", "The eval has an active organization", orgs.body);
  state.organizationId = active.id;
  state.organizationName = active.name ?? "the organization";
}

async function prepareEnterprisePolicySurface(ctx) {
  await ensureOrganization(ctx);
  const plan = await denApiFetch(`/v1/admin/organizations/${state.organizationId}/plan`, {
    method: "PATCH",
    body: JSON.stringify({ tier: "enterprise", seatLimit: 25 }),
  });
  ctx.output("enterprise-plan-prep", JSON.stringify({ status: plan.response.status, body: plan.body }, null, 2));

  const capabilities = await denApiFetch(`/v1/admin/organizations/${state.organizationId}/capabilities`, {
    method: "PUT",
    body: JSON.stringify({ capabilities: { installLinks: true } }),
  });
  ctx.output("install-links-capability-prep", JSON.stringify({ status: capabilities.response.status, body: capabilities.body }, null, 2));
}

async function setAllowedDesktopVersions(ctx, versions) {
  await prepareEnterprisePolicySurface(ctx);
  const updated = await denApiFetch("/v1/org", {
    method: "PATCH",
    body: JSON.stringify({ allowedDesktopVersions: versions }),
  });
  witness(ctx, updated.response.ok, "The organization desktop-version policy is saved", { status: updated.response.status, body: updated.body });
  return updated.body?.organization;
}

async function mintInstallToken(ctx, token = DEN_TOKEN) {
  await ensureOrganization(ctx);
  const result = await denApiFetch(`/v1/orgs/${state.organizationId}/install-links`, {
    method: "POST",
    token,
    body: JSON.stringify({ rotate: false }),
  });
  witness(ctx, result.response.ok, "A member can mint an organization install link", { status: result.response.status, body: result.body });
  const installToken = typeof result.body?.token === "string"
    ? result.body.token
    : new URL(result.body?.installPageUrl ?? "http://invalid.local").searchParams.get("token") ?? "";
  witness(ctx, installToken.length >= 8, "The install link carries an opaque token", result.body);
  return installToken;
}

async function fetchInstallerDownload(token) {
  const response = await fetch(`${DEN_API_URL}/v1/install/win-x64?token=${encodeURIComponent(token)}`, {
    redirect: "manual",
  });
  return {
    status: response.status,
    location: response.headers.get("location"),
    contentDisposition: response.headers.get("content-disposition"),
  };
}

function downloadMentionsVersion(download, version) {
  const evidence = `${download.location ?? ""}\n${download.contentDisposition ?? ""}`;
  return evidence.includes(version);
}

export default {
  id: FLOW_ID,
  title: "Organization install links download the highest allowed desktop version",
  kind: "user-facing",
  requiresApp: false,
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_TOKEN"],
  steps: [
    {
      name: "Frame 1 — Admin restricts desktop versions",
      run: async (ctx) => {
        await ctx.prove("An admin saves a policy allowing 0.17.26 and 0.17.27 while 0.17.28 remains disallowed", {
          voiceover: vo[0],
          action: async () => {
            const organization = await setAllowedDesktopVersions(ctx, ALLOWED_VERSIONS);
            ctx.output("allowed-desktop-versions", JSON.stringify({ organizationId: state.organizationId, organization }, null, 2));
          },
          assert: async () => {
            const current = await denApiFetch("/v1/org");
            const versions = readOrganizationMetadata(current.body?.organization).allowedDesktopVersions;
            witness(ctx, Array.isArray(versions), "The saved organization metadata exposes allowedDesktopVersions", current.body);
            witness(ctx, versions.includes("0.17.26") && versions.includes(SELECTED_VERSION), "The saved policy includes the two allowed versions", versions);
            witness(ctx, !versions.includes(DISALLOWED_VERSION), "The saved policy excludes the disallowed latest version", versions);
          },
        });
      },
    },
    {
      name: "Frame 2 — Non-admin resolves the same org install token",
      run: async (ctx) => {
        await ctx.prove("A non-admin member gets an organization install token from the same policy-backed flow", {
          voiceover: vo[1],
          action: async () => {
            state.memberInstallToken = await mintInstallToken(ctx, MEMBER_TOKEN);
          },
          assert: async () => {
            const config = await denApiFetch(`/v1/install-config?token=${encodeURIComponent(state.memberInstallToken)}`, { auth: false });
            witness(ctx, config.response.ok, "The public install token resolves without a dashboard session", { status: config.response.status, body: config.body });
            witness(ctx, config.body?.clientName === state.organizationName, "The install token is tied to the organization, not to the caller role", config.body);
            witness(ctx, config.body?.requireSignin === true, "The guided installer still requires normal sign-in", config.body);
          },
        });
      },
    },
    {
      name: "Frame 3 — Download selects the highest allowed version",
      run: async (ctx) => {
        await ctx.prove("Clicking download returns OpenWork 0.17.27 instead of the disallowed 0.17.28 release", {
          voiceover: vo[2],
          action: async () => {
            state.restrictedDownload = await fetchInstallerDownload(state.memberInstallToken);
          },
          assert: async () => {
            witness(ctx, [200, 302].includes(state.restrictedDownload.status), "The installer endpoint returns a download or redirect", state.restrictedDownload);
            witness(ctx, downloadMentionsVersion(state.restrictedDownload, SELECTED_VERSION), "The selected direct URL or artifact filename contains 0.17.27", state.restrictedDownload);
            witness(ctx, !downloadMentionsVersion(state.restrictedDownload, DISALLOWED_VERSION), "The selected download does not contain disallowed 0.17.28", state.restrictedDownload);
          },
        });
      },
    },
    {
      name: "Frame 4 — Unrestricted org keeps Den default",
      run: async (ctx) => {
        await ctx.prove("Removing the allowed-version restriction restores Den's configured installer release", {
          voiceover: vo[3],
          action: async () => {
            await setAllowedDesktopVersions(ctx, null);
            state.unrestrictedInstallToken = await mintInstallToken(ctx, DEN_TOKEN);
            state.unrestrictedDownload = await fetchInstallerDownload(state.unrestrictedInstallToken);
          },
          assert: async () => {
            witness(ctx, [200, 302].includes(state.unrestrictedDownload.status), "The unrestricted installer endpoint returns a download or redirect", state.unrestrictedDownload);
            witness(ctx, downloadMentionsVersion(state.unrestrictedDownload, DEFAULT_RELEASE_VERSION), `The unrestricted download uses Den's configured ${DEFAULT_RELEASE_TAG} release`, state.unrestrictedDownload);
          },
        });
      },
    },
  ],
};
