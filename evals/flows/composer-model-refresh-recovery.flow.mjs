import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "composer-model-refresh-recovery";
const EMPTY_MESSAGE = "Your organization hasn't published any models for you yet.";
const PROVIDER_NAME = "Composer Model Refresh Proof";
const MODEL_ID = "gpt-5.4";
const READY_DRAFT = "Ready with the assigned model.";
const ADMIN_EXCEPTION_POLICY_NAME = "Admins may add providers";
const ORG_SLUG = "default";
const OWNER_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const vo = await loadVoiceoverParagraphs(FLOW_ID);
if (!vo) throw new Error(`Missing approved voice-over script for ${FLOW_ID}.`);

const state = {
  orgId: "",
  ownerMemberId: "",
  providerId: "",
  defaultPolicy: null,
  adminExceptionPolicies: [],
};

function apiBase(ctx) {
  const value = (ctx.env.OPENWORK_EVAL_DEN_API_URL ?? "").trim().replace(/\/+$/, "");
  ctx.assert(Boolean(value), "OPENWORK_EVAL_DEN_API_URL is required.");
  return value;
}

function webBase(ctx) {
  const value = (ctx.env.OPENWORK_EVAL_DEN_WEB_URL ?? "").trim().replace(/\/+$/, "");
  ctx.assert(Boolean(value), "OPENWORK_EVAL_DEN_WEB_URL is required.");
  return value;
}

function adminToken(ctx) {
  const value = (ctx.env.OPENWORK_EVAL_DEN_TOKEN ?? "").trim();
  ctx.assert(Boolean(value), "OPENWORK_EVAL_DEN_TOKEN is required.");
  return value;
}

function safeBody(body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 900);
}

async function request(ctx, path, options = {}, allowedStatuses = []) {
  const response = await fetch(`${apiBase(ctx)}${path}`, {
    ...options,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      origin: webBase(ctx),
      authorization: `Bearer ${adminToken(ctx)}`,
      ...(state.orgId ? { "x-openwork-org-id": state.orgId } : {}),
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok && !allowedStatuses.includes(response.status)) {
    ctx.assert(false, `${options.method ?? "GET"} ${path} failed with ${response.status}: ${safeBody(body)}`);
  }
  return { response, body };
}

async function selectOrganization(ctx) {
  const orgs = await request(ctx, "/v1/me/orgs", {
    headers: { authorization: `Bearer ${adminToken(ctx)}` },
  });
  const list = Array.isArray(orgs.body?.orgs) ? orgs.body.orgs : [];
  const org = list.find((entry) => entry?.slug === ORG_SLUG) ?? null;
  ctx.assert(Boolean(org?.id), "The eval admin has no organization.");
  state.orgId = org.id;
  const active = await request(ctx, "/v1/me/active-organization", {
    method: "POST",
    body: JSON.stringify({ organizationId: org.id }),
  });
  ctx.assert(active.body?.activeOrgId === org.id, "The eval organization became active.");
}

async function loadOrg(ctx) {
  const result = await request(ctx, "/v1/org");
  ctx.assert(Boolean(result.body?.organization?.id), "The active organization loaded.");
  return result.body;
}

function policyUpdateBody(policy, overrides = {}) {
  return {
    policyName: policy.policyName,
    policy: policy.policy ?? {},
    priority: policy.priority ?? 0,
    isEnabled: policy.isEnabled ?? true,
    memberIds: (policy.assignments ?? []).flatMap((assignment) => assignment.memberId ? [assignment.memberId] : []),
    teamIds: (policy.assignments ?? []).flatMap((assignment) => assignment.teamId ? [assignment.teamId] : []),
    roles: policy.roles ?? [],
    ...overrides,
  };
}

async function configureManagedEmptyState(ctx) {
  const org = await loadOrg(ctx);
  const owner = (org.members ?? []).find((member) =>
    member?.role === "owner" || member?.user?.email?.toLowerCase() === OWNER_EMAIL.toLowerCase()
  );
  ctx.assert(Boolean(owner?.id), `Could not find ${OWNER_EMAIL}'s organization membership.`);
  state.ownerMemberId = owner.id;

  const policiesResult = await request(ctx, "/v1/desktop-policies");
  const policies = Array.isArray(policiesResult.body?.desktopPolicies)
    ? policiesResult.body.desktopPolicies
    : [];
  const defaultPolicy = policies.find((policy) => policy?.isDefault);
  ctx.assert(Boolean(defaultPolicy?.id), "The organization has a default desktop policy.");
  state.defaultPolicy = defaultPolicy;
  state.adminExceptionPolicies = policies.filter(
    (policy) => !policy?.isDefault && policy?.policyName === ADMIN_EXCEPTION_POLICY_NAME,
  );

  await request(ctx, `/v1/desktop-policies/${encodeURIComponent(defaultPolicy.id)}`, {
    method: "PATCH",
    body: JSON.stringify(policyUpdateBody(defaultPolicy, {
      policy: {
        ...(defaultPolicy.policy ?? {}),
        allowCustomProviders: false,
        allowZenModel: false,
      },
    })),
  });

  for (const policy of state.adminExceptionPolicies.filter((entry) => entry?.isEnabled)) {
    await request(ctx, `/v1/desktop-policies/${encodeURIComponent(policy.id)}`, {
      method: "PATCH",
      body: JSON.stringify(policyUpdateBody(policy, { isEnabled: false })),
    });
  }
}

async function deleteProofProviders(ctx) {
  const result = await request(ctx, "/v1/llm-providers?scope=manageable");
  const providers = Array.isArray(result.body?.llmProviders) ? result.body.llmProviders : [];
  for (const provider of providers.filter((entry) => entry?.name === PROVIDER_NAME)) {
    if (!provider?.id) continue;
    await request(ctx, `/v1/llm-providers/${encodeURIComponent(provider.id)}`, {
      method: "DELETE",
    }, [204, 404]);
  }
}

async function createProofProvider(ctx) {
  const result = await request(ctx, "/v1/llm-providers", {
    method: "POST",
    body: JSON.stringify({
      name: PROVIDER_NAME,
      source: "models_dev",
      providerId: "openai",
      modelIds: [MODEL_ID],
      apiKey: "sk-openwork-local-eval-only",
      memberIds: [state.ownerMemberId],
      teamIds: [],
    }),
  });
  state.providerId = result.body?.llmProvider?.id ?? "";
  ctx.assert(Boolean(state.providerId), "The assigned organization provider was created.");
}

async function restoreState(ctx) {
  if (state.providerId) {
    await request(ctx, `/v1/llm-providers/${encodeURIComponent(state.providerId)}`, {
      method: "DELETE",
    }, [204, 404]);
  } else {
    await deleteProofProviders(ctx);
  }

  if (state.defaultPolicy?.id) {
    await request(ctx, `/v1/desktop-policies/${encodeURIComponent(state.defaultPolicy.id)}`, {
      method: "PATCH",
      body: JSON.stringify(policyUpdateBody(state.defaultPolicy)),
    });
  }
  for (const policy of state.adminExceptionPolicies) {
    await request(ctx, `/v1/desktop-policies/${encodeURIComponent(policy.id)}`, {
      method: "PATCH",
      body: JSON.stringify(policyUpdateBody(policy)),
    });
  }
}

async function clickEmptyStateNotice(ctx) {
  await ctx.waitFor(`(() => {
    const button = [...document.querySelectorAll("button")].find((entry) => {
      const text = entry.textContent || "";
      return text.includes(${JSON.stringify(EMPTY_MESSAGE)}) && text.includes("Retry") && !entry.disabled;
    });
    button?.click();
    return Boolean(button);
  })()`, { timeoutMs: 30_000, label: "click the compact organization-model notice" });
}

export default {
  id: FLOW_ID,
  title: "Composer retries organization models without an app restart",
  kind: "user-facing",
  requiresApp: true,
  spec: "evals/voiceovers/composer-model-refresh-recovery.md",
  requiredEnv: [
    "OPENWORK_EVAL_DEN_API_URL",
    "OPENWORK_EVAL_DEN_WEB_URL",
    "OPENWORK_EVAL_DEN_TOKEN",
  ],
  steps: [
    {
      name: "Setup — managed access with no assigned models",
      run: async (ctx) => {
        await selectOrganization(ctx);
        await deleteProofProviders(ctx);
        await configureManagedEmptyState(ctx);
        ctx.log("Managed no-model policy is configured.");
        await ctx.eval('location.hash = "#/session"; location.reload()');
        await ctx.waitFor("Boolean(window.__openworkControl)", {
          timeoutMs: 60_000,
          label: "OpenWork control API after clean-state reload",
        });
        const desktopContext = await ctx.eval(`({
          signedIn: Boolean((localStorage.getItem("openwork.den.authToken") ?? "").trim()),
          activeOrgId: localStorage.getItem("openwork.den.activeOrgId") ?? "",
        })`);
        ctx.assert(desktopContext.signedIn, "The desktop is signed into the isolated Den stack.");
        ctx.assert(
          desktopContext.activeOrgId === state.orgId,
          `The desktop uses the eval organization (actual: ${desktopContext.activeOrgId}).`,
        );
        await ctx.eval('location.hash = "#/session"');
        const workspacePath = join(tmpdir(), "openwork-composer-model-refresh-proof");
        await mkdir(workspacePath, { recursive: true });
        await ctx.waitFor(
          "window.__openworkControl?.listActions().some((action) => action.id === 'workspace.create' && !action.disabled)",
          { timeoutMs: 60_000, label: "workspace.create action" },
        );
        await ctx.control("workspace.create", { path: workspacePath });
        await ctx.waitFor(
          '/^#\\/workspace\\/[^/?#]+\\/session\\/ses_[^/?#]+/.test(window.location.hash)',
          { timeoutMs: 120_000, label: "created workspace session route" },
        );
        await ctx.waitFor("document.body.innerText.includes('Run task')", {
          timeoutMs: 60_000,
          label: "composer action area",
        });
        ctx.log("Local workspace is ready.");
        await ctx.waitForText(EMPTY_MESSAGE, { timeoutMs: 120_000 });
      },
    },
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("A user with no assigned models sees one compact retry notice", {
          voiceover: vo[0],
          assert: async () => {
            const notice = await ctx.eval(`(() => {
              const button = [...document.querySelectorAll("button")].find((entry) => {
                const text = entry.textContent || "";
                return text.includes(${JSON.stringify(EMPTY_MESSAGE)}) && text.includes("Retry");
              });
              const message = button?.querySelector("span");
              if (!button || !message) return null;
              const rect = button.getBoundingClientRect();
              return {
                height: Math.round(rect.height),
                text: button.textContent,
                whiteSpace: getComputedStyle(message).whiteSpace,
              };
            })()`);
            ctx.assert(Boolean(notice), "The organization-model retry notice is visible.");
            ctx.assert(notice.height <= 30, `The retry notice stays compact (actual height: ${notice.height}px).`);
            ctx.assert(notice.whiteSpace === "nowrap", `The empty-state text does not wrap (white-space: ${notice.whiteSpace}).`);
          },
          screenshot: {
            name: "compact-no-models-retry",
            requireText: [EMPTY_MESSAGE, "Retry", "Run task"],
          },
        });
      },
    },
    {
      name: "Setup — assign GPT-5.4 while the app remains open",
      run: async (ctx) => {
        await createProofProvider(ctx);
        await ctx.expectText(EMPTY_MESSAGE);
        await ctx.expectText("Retry");
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("The newly assigned model appears without restarting OpenWork", {
          voiceover: vo[1],
          action: async () => {
            await clickEmptyStateNotice(ctx);
            await ctx.waitFor(`!document.body.innerText.includes(${JSON.stringify(EMPTY_MESSAGE)})`, {
              timeoutMs: 120_000,
              label: "managed-model empty state to clear",
            });
            await ctx.waitFor(
              `document.body.innerText.includes("GPT-5.4") || document.body.innerText.includes(${JSON.stringify(MODEL_ID)})`,
              { timeoutMs: 120_000, label: "assigned GPT-5.4 model" },
            );
            await ctx.control("composer.set_text", { text: READY_DRAFT });
            await ctx.waitForText(READY_DRAFT, { timeoutMs: 30_000 });
          },
          assert: async () => {
            await ctx.expectNoText(EMPTY_MESSAGE);
            const composer = await ctx.eval(`(() => {
              const text = document.body.innerText || "";
              const run = [...document.querySelectorAll("button")].find((button) =>
                (button.textContent || "").includes("Run task")
              );
              return {
                hasModel: text.includes("GPT-5.4") || text.includes(${JSON.stringify(MODEL_ID)}),
                runEnabled: Boolean(run && !run.disabled),
              };
            })()`);
            ctx.assert(composer.hasModel, "GPT-5.4 is visible after refresh.");
            ctx.assert(composer.runEnabled, "The composer is ready to run a task after refresh.");
          },
          screenshot: {
            name: "assigned-model-ready-without-restart",
            requireText: ["GPT-5.4", READY_DRAFT, "Run task"],
            rejectText: [EMPTY_MESSAGE, "Refreshing…"],
          },
        });
      },
    },
    {
      name: "Cleanup — restore organization model policy",
      run: async (ctx) => {
        await restoreState(ctx);
      },
    },
  ],
};
