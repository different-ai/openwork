import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { connect, debuggerUrlFor, listTargets } from "../runner/cdp.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import { denApiFetch, denApiUrl, denWebUrl, signInViaBrowser } from "./lib/den-web.mjs";
import {
  createDesktopHandoff,
  deliverDesktopDeepLink,
  readTranscriptSnapshot,
  sendPromptAndWait,
  signInByEmail,
  sleep,
} from "./enterprise-gateway-common.mjs";

const FLOW_ID = "invitee-first-boot-just-works";
const vo = await loadVoiceoverParagraphs(FLOW_ID);
if (!vo) throw new Error(`Missing approved voice-over script for ${FLOW_ID}.`);

const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const MAYA_EMAIL = "maya.firstboot@acme.test";
const MAYA_PASSWORD = "OpenWorkDemo123!";
const ORG_SLUG = "acme-robotics-demo";
const ORG_NAME = "Acme Robotics";
const ENGINEERING_TEAM = "Engineering";
const PROVIDER_NAME = "Acme Approved Models";
const MODEL_IDS = ["gpt-5.4", "gpt-5.5"];
const TARGET_REPLY = "acme-first-boot-ok";
const RELOAD_TEXT = "Reloading OpenCode config";
const EDITOR_SELECTOR = '[contenteditable="true"][data-lexical-editor="true"]';
const ADMIN_CDP_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_WEB_CDP_ADMIN);
const INVITEE_CDP_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_WEB_CDP_INVITEE);
const MARK_VERIFIED_CMD = process.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim() || "";
const ERROR_TEXT = ["Something went wrong", "Failed", "Could not", "Only workspace"];

const state = {
  adminToken: "",
  orgId: "",
  defaultPolicyId: "",
  engineeringTeamId: "",
  providerId: "",
  inviteToken: "",
  invitationId: "",
  inviteeHadExistingAccount: false,
  adminBrowserSignedIn: false,
  mayaBearer: "",
  desktopWorkspaceId: "",
  desktopSessionId: "",
  firstBootGuardArmed: false,
  firstBootResult: null,
  frame6ModelOptions: [],
  frame6AddProviderResult: null,
  frame7: null,
  frame7Table: "",
  defaultModelPreselectedOk: true,
  defaultModelBeforeFirstMessage: null,
  firstMessageTranscript: "",
  firstMessageError: "",
};

export default {
  id: FLOW_ID,
  title: "Invited member first boot is already configured with only Acme-approved models",
  kind: "user-facing",
  requiresApp: true,
  spec: "evals/voiceovers/invitee-first-boot-just-works.md",
  requiredEnv: [
    "OPENWORK_EVAL_DEN_API_URL",
    "OPENWORK_EVAL_DEN_WEB_URL",
    "OPENWORK_EVAL_DEN_TOKEN",
    "OPENWORK_EVAL_WEB_CDP_ADMIN",
    "OPENWORK_EVAL_WEB_CDP_INVITEE",
  ],
  precondition: () => {
    if (!orgModelApiKey()) {
      return "Missing OPENWORK_EVAL_ORG_MODEL_API_KEY or OPENAI_API_KEY; frame 8 needs a real org-held model key.";
    }
    return null;
  },
  steps: [
    {
      name: "Setup — select Acme and clean prior invite/model artifacts",
      run: async (ctx) => {
        await ensureAdminApiSession(ctx);
        await cleanupPriorEvalArtifacts(ctx);
        await setDefaultDesktopPolicyValues(ctx, { allowCustomProviders: true, allowZenModel: true });
      },
    },
    {
      name: "Frame 1",
      run: async (ctx) => {
        await withClient(ctx, ADMIN_CDP_URL, async () => {
          await ctx.prove("Alex restricts the org-wide desktop policy to Acme-provided models", {
            voiceover: vo[0],
            action: async () => {
              await openAdminPage(ctx, "/dashboard/custom-llm-providers", "Who can use models");
              await setModelAccessCard(ctx, {
                mode: "managed",
                adminException: true,
                zenAllowed: false,
              });
            },
            assert: async () => {
              const policy = await getDefaultDesktopPolicy(ctx);
              ctx.assert(policy.policy?.allowCustomProviders === false, "Default desktop policy has allowCustomProviders === false.");
              ctx.assert(policy.policy?.allowZenModel === false, "Default desktop policy has allowZenModel === false.");
              await assertModelAccessCard(ctx, {
                mode: "managed",
                adminException: true,
                zenAllowed: false,
              });
            },
            screenshot: {
              name: "default-policy-org-models-only",
              requireText: ["Who can use models", "Managed", "Admins may add their own providers", "Allow OpenCode Zen models", "Model access saved."],
              rejectText: ERROR_TEXT,
            },
          });
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await withClient(ctx, ADMIN_CDP_URL, async () => {
          await ctx.prove("Alex publishes exactly GPT-5.4 and GPT-5.5 as the Acme model menu", {
            voiceover: vo[1],
            action: async () => {
              await ensureCatalogModelsExist(ctx);
              const created = await createApprovedModelProvider(ctx);
              state.providerId = created.id;
              await openAdminPage(ctx, "/dashboard/custom-llm-providers", "LLM Providers");
              await ctx.waitForText(PROVIDER_NAME, { timeoutMs: 30_000 });
              await ctx.waitForText("2 models", { timeoutMs: 30_000 });
              await openAdminPage(ctx, `/dashboard/custom-llm-providers/${encodeURIComponent(created.id)}`, "Selected models");
              await ctx.waitForText("GPT-5.4", { timeoutMs: 30_000 });
              await ctx.waitForText("GPT-5.5", { timeoutMs: 30_000 });
            },
            assert: async () => {
              const provider = await assertApprovedProvider(ctx);
              state.providerId = provider.id;
              await ctx.expectText(PROVIDER_NAME);
              await ctx.expectText("2 models");
              await ctx.expectText("Credential saved");
              await ctx.expectText("Selected models");
              await ctx.expectText("GPT-5.4");
              await ctx.expectText("GPT-5.5");
            },
            screenshot: {
              name: "acme-approved-models-list",
              requireText: ["Selected models", PROVIDER_NAME, "2 models", "Credential saved", "GPT-5.4", "GPT-5.5"],
              rejectText: ERROR_TEXT,
            },
          });
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await withClient(ctx, ADMIN_CDP_URL, async () => {
          await ctx.prove("Maya is invited from Members and appears as pending", {
            voiceover: vo[2],
            action: async () => {
              await openAdminPage(ctx, "/dashboard/members", "Members");
              await installInvitationCapture(ctx);
              await clickExactText(ctx, "Add member", "button");
              await ctx.waitFor("Boolean(document.querySelector('input[placeholder=\"teammate@example.com\"]'))", {
                timeoutMs: 20_000,
                label: "invite email input",
              });
              await ctx.fill('input[placeholder="teammate@example.com"]', MAYA_EMAIL);
              await setInviteRole(ctx, "member");
              await selectInviteEngineeringIfPresent(ctx);
              await clickExactText(ctx, "Send invite", "button");
              await ctx.waitForText(MAYA_EMAIL, { timeoutMs: 30_000 });
              await ctx.waitForText("Pending", { timeoutMs: 30_000 });

              const captured = await ctx.eval("window.__ifbInvitationCapture ?? null");
              if (captured?.body?.invitationId) state.invitationId = captured.body.invitationId;
              if (captured?.body?.inviteToken) state.inviteToken = captured.body.inviteToken;
              await assignMayaInviteToEngineering(ctx);
            },
            assert: async () => {
              const { invitation, member, engineeringTeam } = await assertPendingMayaInvitation(ctx);
              state.invitationId = invitation.id ?? invitation.invitationId ?? state.invitationId;
              state.inviteToken = invitation.inviteToken ?? state.inviteToken;
              ctx.assert(Boolean(state.inviteToken), "Maya's pending invitation exposes an invite token.");
              ctx.assert(engineeringTeam.memberIds.includes(member.id), "Maya's invited member row belongs to Engineering for inherited model access.");
              await ctx.expectText(MAYA_EMAIL);
              await ctx.expectText("Pending");
            },
            screenshot: {
              name: "maya-pending-members-row",
              requireText: [MAYA_EMAIL, "Pending", "Member"],
              rejectText: ERROR_TEXT,
            },
          });
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await withClient(ctx, INVITEE_CDP_URL, async () => {
          await ctx.prove("Maya accepts the invite and lands on the desktop-app handoff", {
            voiceover: vo[3],
            action: async () => {
              const inviteLink = inviteUrl(ctx);
              state.inviteeHadExistingAccount = await inviteeCanSignIn(ctx);
              await clearDenWebSession(ctx);
              await navigateAbsolute(ctx, inviteLink);
              await ctx.waitFor("document.querySelector('[data-testid=\"join-org-root\"]')?.getAttribute('data-state') === 'signed-out'", {
                timeoutMs: 45_000,
                label: "signed-out join screen",
              });
              await assertJoinInvitationDetails(ctx);
              await completeMayaJoin(ctx);
              await redactInviteCredentialInPage(ctx);
            },
            assert: async () => {
              await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"join-org-success\"]'))", {
                timeoutMs: 45_000,
                label: "join org success",
              });
              await ctx.expectText("You're in");
              await ctx.expectText("Get the desktop app");
              await assertMayaAcceptedAndActive(ctx);
              await redactInviteCredentialInPage(ctx);
            },
            screenshot: {
              name: "maya-joined-get-desktop-app",
              requireText: ["You're in", ORG_NAME, "Get the desktop app"],
              rejectText: ["Something went wrong", "invite="],
            },
          });
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        try {
          await ctx.prove("Maya's first desktop boot signs into Acme without modals or refresh loops", {
            voiceover: vo[4],
            action: async () => {
              await withClient(ctx, INVITEE_CDP_URL, async () => {
                await openInstallGuideFromJoinSuccess(ctx);
                await ctx.screenshot("maya-installs-openwork-guide", {
                  claim: "Maya reaches Acme's install/download guide before opening her first desktop session.",
                  voiceover: vo[4],
                  requireText: ["Download OpenWork", "Download the OpenWork installer", "Open OpenWork"],
                  rejectText: ERROR_TEXT,
                });
              });

              state.mayaBearer = await signInMayaByEmail(ctx);
              const openworkUrl = await createDesktopHandoff(ctx, state.mayaBearer);

              await resetDesktopToColdFirstBoot(ctx);
              await armFirstBootProbe(ctx);
              state.firstBootGuardArmed = true;
              const deliveredAt = Date.now();
              await deliverDesktopDeepLink(ctx, openworkUrl);
              state.firstBootResult = await waitForFirstBootWorkspace(ctx, deliveredAt, 60_000);
              await freezeFirstBootDialogRecorder(ctx);
              state.firstBootGuardArmed = false;
            },
            assert: async () => {
              const desktop = await readDesktopSessionState(ctx);
              const probe = await readFirstBootProbe(ctx);
              const onboarding = state.firstBootResult?.onboarding ?? { count: 0, labels: [] };
              const elapsedMs = state.firstBootResult?.elapsedMs ?? Number.POSITIVE_INFINITY;
              ctx.output("frame-5-first-boot", JSON.stringify({
                rendererColdBoot: "Renderer cold boot on an isolated OPENWORK_ELECTRON_USERDATA profile after clearing Den renderer/session caches, preferences, and prior lpr_* workspace imports. This is not a fresh OS install.",
                elapsedMs,
                onboardingClicks: onboarding.count,
                onboardingClickLabels: onboarding.labels,
                authTokenSet: desktop.authTokenSet,
                activeOrgId: desktop.activeOrgId,
                hash: desktop.hash,
                workspaceId: desktop.workspaceId,
                sessionId: desktop.sessionId,
                composerReady: desktop.hasComposer,
                pageReloadsAfterArming: probe.pageReloadsAfterArming,
              }, null, 2));
              ctx.assert(desktop.authTokenSet, "openwork.den.authToken is set after the first desktop handoff.");
              ctx.assert(Boolean(desktop.activeOrgId), "openwork.den.activeOrgId is set after the first desktop handoff.");
              ctx.assert(desktop.usableSessionRoute, `Desktop is on a usable workspace session route (actual hash: ${desktop.hash}).`);
              ctx.assert(desktop.hasComposer, "The composer is ready without eval assistance.");
              ctx.assert(elapsedMs <= 60_000, `First boot reached composer-ready in ${elapsedMs}ms (ceiling 60000ms).`);
              ctx.assert(probe.pageReloadsAfterArming === 0, `Page reloaded ${probe.pageReloadsAfterArming} time(s) after the first-boot probe armed.`);
              ctx.assert(onboarding.count === 0, `Expected onboardingClicks === 0, got ${onboarding.count}: ${onboarding.labels.join(" -> ") || "none"}`);
            },
            screenshot: {
              name: "maya-first-desktop-boot-ready",
              requireText: ["Run task"],
              rejectText: ["Choose your organization", "You have access to the following resources.", "Continue to workspace", "Restart OpenWork", RELOAD_TEXT],
              hashIncludes: "/session",
            },
          });
        } finally {
          state.firstBootGuardArmed = false;
        }
      },
    },
    {
      name: "Frame 6",
      run: async (ctx) => {
        try {
          await ctx.prove("Maya's model menu contains only GPT-5.4 and GPT-5.5", {
            voiceover: vo[5],
            action: async () => {
              await openModelPicker(ctx);
              state.frame6ModelOptions = await readModelPickerOptions(ctx);
              const addResult = await controlRaw(ctx, "settings.provider.add");
              state.frame6AddProviderResult = addResult;
            },
            assert: async () => {
              const options = state.frame6ModelOptions;
              const modelIds = options.map((option) => option.modelId).sort();
              const providerIds = [...new Set(options.map((option) => option.providerId))].sort();
              ctx.output("frame-6-model-picker-options", JSON.stringify({ options, modelIds, providerIds, addProviderResult: state.frame6AddProviderResult }, null, 2));
              ctx.assert(JSON.stringify(modelIds) === JSON.stringify([...MODEL_IDS].sort()), `Model picker selectable ids must equal ${MODEL_IDS.join(", ")}; saw ${modelIds.join(", ") || "none"}. Full rows: ${JSON.stringify(options)}`);
              ctx.assert(providerIds.length === 1 && providerIds[0]?.startsWith("lpr_"), `All model picker options must be under one org lpr_* provider; saw providers ${providerIds.join(", ") || "none"}.`);
              ctx.assert(state.frame6AddProviderResult?.ok === false, `settings.provider.add should be blocked by org policy; got ${JSON.stringify(state.frame6AddProviderResult)}.`);
              ctx.assert(String(state.frame6AddProviderResult?.error ?? "").includes("Custom providers are disabled by your organization."), `settings.provider.add returned the wrong org-policy error: ${JSON.stringify(state.frame6AddProviderResult)}.`);
              const connectAffordance = await modelPickerDialogHasText(ctx, "Connect a provider");
              ctx.assert(!connectAffordance, "The model picker must not render a Connect a provider affordance under managed policy.");
              await ctx.expectText("GPT-5.4");
              await ctx.expectText("GPT-5.5");
            },
            screenshot: {
              name: "maya-model-picker-acme-only",
              requireText: ["GPT-5.4", "GPT-5.5"],
              rejectText: ["OpenCode Zen", "Use OpenWork Models", "Subscribe to add this model", "no longer available"],
            },
          });
        } finally {
          await closeModelPicker(ctx).catch(() => undefined);
        }
      },
    },
    {
      name: "Frame 7",
      run: async (ctx) => {
        await ctx.prove("The desktop sync writes once and shows no reload/config churn", {
          voiceover: vo[6],
          action: async () => {
            await ensureSessionReady(ctx);
            const probe = await readFirstBootProbe(ctx);
            const reloadBannerSamples = await sampleReloadBanner(ctx);
            const runtimeHashes = await readRuntimeConfigHashes(ctx, state.desktopWorkspaceId);
            const configState = await readWorkspaceConfigState(ctx, state.desktopWorkspaceId);
            const notifications = await listNotifications(ctx);
            const reloadNotifications = notifications.filter((entry) => notificationLooksReloadRelated(entry));
            const dialogs = Array.isArray(probe.dialogs) ? probe.dialogs : [];
            const importedLpr = lprKeys(configState.providers);
            const runtimeLpr = lprKeys(configState.runtimeProviders);
            state.frame7 = {
              probe,
              reloadBannerSamples,
              runtimeHashes,
              configState,
              notifications,
              reloadNotifications,
              importedLpr,
              runtimeLpr,
              dialogs,
            };
            state.frame7Table = quietBootTable(state.frame7);
            ctx.output("frame-7-quiet-boot-table", state.frame7Table);
          },
          assert: async () => {
            const frame = state.frame7;
            ctx.assert(frame.dialogs.length === 0, `Dialog history should be clean; recorded ${frame.dialogs.length}: ${frame.dialogs.map((dialog) => `${dialog.testid || "no-testid"}:${dialog.title || firstLine(dialog.text)}`).join(" | ")}`);
            ctx.assert(frame.probe.counters.engineReloads <= 1, `engineReloads <= 1 expected; got ${frame.probe.counters.engineReloads}.`);
            ctx.assert(frame.probe.counters.configWrites <= 2, `configWrites <= 2 expected; got ${frame.probe.counters.configWrites}.`);
            ctx.assert(frame.probe.pageReloadsAfterArming === 0, `pageReloadsAfterArming === 0 expected; got ${frame.probe.pageReloadsAfterArming}.`);
            ctx.assert(frame.reloadBannerSamples.positives === 0, `saw "${RELOAD_TEXT}" ${frame.reloadBannerSamples.positives}/30 samples.`);
            ctx.assert(new Set(frame.runtimeHashes.map((entry) => entry.hash)).size === 1, `Runtime config hash changed across samples: ${JSON.stringify(frame.runtimeHashes)}.`);
            ctx.assert(frame.importedLpr.length === 1, `Expected exactly one lpr_ cloud import, got ${frame.importedLpr.length}: ${frame.importedLpr.join(", ") || "none"}.`);
            ctx.assert(frame.runtimeLpr.includes(frame.importedLpr[0]), `Runtime providers did not include imported provider ${frame.importedLpr[0]}: ${frame.runtimeLpr.join(", ") || "none"}.`);
            ctx.assert(frame.configState.engineConnectedProviders.length === 1 && frame.configState.engineConnectedProviders[0] === frame.importedLpr[0], `Engine connected providers should equal the org entitlement ${frame.importedLpr[0]}; got ${frame.configState.engineConnectedProviders.join(", ") || "none"}.`);
            ctx.assert(frame.configState.disabledProviders.includes("openai"), `Runtime disabled_providers should contain openai after env-provider reconciliation; got ${frame.configState.disabledProviders.join(", ") || "none"}.`);
            ctx.assert(frame.reloadNotifications.length === 0, `Reload-related notifications were present: ${JSON.stringify(frame.reloadNotifications)}.`);
          },
          screenshot: {
            name: "quiet-boot-no-reload-churn",
            requireText: ["Run task"],
            rejectText: [RELOAD_TEXT, "Restart OpenWork"],
            hashIncludes: "/session",
          },
        });
      },
    },
    {
      name: "Frame 8",
      run: async (ctx) => {
        await ctx.prove("Maya sends her first GPT-5.5 message successfully", {
          voiceover: vo[7],
          action: async () => {
            await ensureSessionReady(ctx);
            const before = await readDefaultModel(ctx);
            state.defaultModelBeforeFirstMessage = before;
            state.defaultModelPreselectedOk = Boolean(before?.providerID?.startsWith("lpr_") && MODEL_IDS.includes(before.modelID));
            ctx.output("frame-8-default-model-before-message", JSON.stringify(before, null, 2));
            if (!state.defaultModelPreselectedOk || before?.modelID !== "gpt-5.5") {
              await selectModel(ctx, "gpt-5.5");
              ctx.output("frame-8-selected-model-for-reply", JSON.stringify({ reason: state.defaultModelPreselectedOk ? "default org model was not GPT-5.5" : "default model was missing or not an org model", selectedModel: await readDefaultModel(ctx) }, null, 2));
            }
            try {
              state.firstMessageTranscript = await sendPromptAndWait(ctx, `Reply with exactly: ${TARGET_REPLY}`, { timeout: 300_000 });
            } catch (error) {
              const snapshot = await readTranscriptSnapshot(ctx).catch(() => null);
              state.firstMessageError = safeBody({ error: error instanceof Error ? error.message : String(error), snapshot });
              ctx.output("frame-8-upstream-or-send-error", state.firstMessageError);
              throw error;
            }
            ctx.output("frame-8-first-message-transcript", safeBody(state.firstMessageTranscript));
          },
          assert: async () => {
            ctx.assert(state.firstMessageTranscript.includes(TARGET_REPLY), `Transcript did not contain ${TARGET_REPLY}. Transcript: ${safeBody(state.firstMessageTranscript)}`);
          },
          screenshot: {
            name: "maya-first-message-acme-ok",
            requireText: [TARGET_REPLY],
            rejectText: ["model_not_found", "no longer available", "Authorization required"],
            hashIncludes: "/session",
          },
        });
        ctx.recordEvidence({
          type: "assertion",
          status: state.defaultModelPreselectedOk ? "passed" : "failed",
          assertion: "The default model was preselected to an organization lpr_* model before Maya sent her first message.",
          actual: state.defaultModelBeforeFirstMessage,
        });
        ctx.assert(state.defaultModelPreselectedOk, `Default model was not preselected to an org model: ${JSON.stringify(state.defaultModelBeforeFirstMessage)}`);
      },
    },
    {
      name: "Cleanup — restore desktop policy and delete Acme provider",
      run: async (ctx) => {
        await cleanupAfterRun(ctx);
      },
    },
  ],
};

function cleanBaseUrl(value) {
  return (value ?? "").trim().replace(/\/+$/, "");
}

function orgModelApiKey() {
  return process.env.OPENWORK_EVAL_ORG_MODEL_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || "";
}

function adminToken(ctx) {
  const token = state.adminToken || process.env.OPENWORK_EVAL_DEN_TOKEN?.trim() || "";
  ctx.assert(token.length > 0, "OPENWORK_EVAL_DEN_TOKEN is required for admin API calls.");
  state.adminToken = token;
  return token;
}

function authHeaders(ctx) {
  return {
    authorization: `Bearer ${adminToken(ctx)}`,
    ...(state.orgId ? { "x-openwork-org-id": state.orgId } : {}),
  };
}

async function apiRequest(ctx, path, options = {}, allowedStatuses = []) {
  const result = await denApiFetch(path, {
    ...options,
    headers: {
      ...(options.headers ?? {}),
    },
  });
  if (!result.response.ok && !allowedStatuses.includes(result.response.status)) {
    ctx.assert(false, `${options.method ?? "GET"} ${path} failed with ${result.response.status}: ${safeBody(result.body)}`);
  }
  return result;
}

async function denApiAuthRequest(path, options = {}) {
  const response = await fetch(`${denApiUrl()}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      origin: denWebUrl(),
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { response, body };
}

async function adminRequest(ctx, path, options = {}, allowedStatuses = []) {
  return apiRequest(ctx, path, {
    ...options,
    headers: {
      ...authHeaders(ctx),
      ...(options.headers ?? {}),
    },
  }, allowedStatuses);
}

function safeBody(body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 700);
}

async function ensureAdminApiSession(ctx) {
  const orgs = await apiRequest(ctx, "/v1/me/orgs", {
    headers: { authorization: `Bearer ${adminToken(ctx)}` },
  });
  const list = Array.isArray(orgs.body?.orgs) ? orgs.body.orgs : [];
  const acme = list.find((org) => org?.slug === ORG_SLUG) ?? null;
  ctx.assert(Boolean(acme?.id), `Admin account could not access ${ORG_SLUG}.`);
  state.orgId = acme.id;

  const active = await apiRequest(ctx, "/v1/me/active-organization", {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken(ctx)}` },
    body: JSON.stringify({ organizationId: acme.id }),
  });
  ctx.assert(active.body?.activeOrgId === acme.id, `Active organization did not switch to ${ORG_SLUG}.`);

  const org = await loadOrg(ctx);
  const team = engineeringTeamFromOrg(ctx, org);
  state.engineeringTeamId = team.id;
}

async function loadOrg(ctx) {
  const result = await adminRequest(ctx, "/v1/org");
  ctx.assert(result.body?.organization?.slug === ORG_SLUG, `Expected active organization ${ORG_SLUG}.`);
  return result.body;
}

function engineeringTeamFromOrg(ctx, org) {
  const teams = Array.isArray(org?.teams) ? org.teams : [];
  const team = teams.find((entry) => entry?.name === ENGINEERING_TEAM) ?? null;
  ctx.assert(Boolean(team?.id), `Expected seeded ${ENGINEERING_TEAM} team in ${ORG_NAME}.`);
  return team;
}

async function cleanupPriorEvalArtifacts(ctx) {
  let org = await loadOrg(ctx);
  const invitations = invitationsForEmail(org, MAYA_EMAIL);
  for (const invitation of invitations) {
    if (invitation.status === "pending") {
      const invitationId = invitation.id ?? invitation.invitationId;
      if (invitationId) {
        await adminRequest(ctx, `/v1/invitations/${encodeURIComponent(invitationId)}/cancel`, { method: "POST" }, [404]);
      }
    }
  }

  org = await loadOrg(ctx);
  for (const member of membersForEmailOrInvite(org, MAYA_EMAIL, invitations)) {
    if (member?.id) {
      await adminRequest(ctx, `/v1/members/${encodeURIComponent(member.id)}`, { method: "DELETE" }, [204, 400, 404]);
    }
  }

  await deleteApprovedProviders(ctx, true);
}

async function cleanupAfterRun(ctx) {
  try {
    await setDefaultDesktopPolicyValues(ctx, { allowCustomProviders: true, allowZenModel: true });
  } catch (error) {
    ctx.log(`Cleanup could not restore the default desktop policy: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    await deleteApprovedProviders(ctx, true);
  } catch (error) {
    ctx.log(`Cleanup could not delete ${PROVIDER_NAME}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

function invitationsForEmail(org, email) {
  const normalized = normalizeEmail(email);
  return (Array.isArray(org?.invitations) ? org.invitations : [])
    .filter((invitation) => normalizeEmail(invitation?.email) === normalized);
}

function membersForEmailOrInvite(org, email, invitations = invitationsForEmail(org, email)) {
  const normalized = normalizeEmail(email);
  const inviteIds = new Set(invitations.map((invitation) => invitation?.id ?? invitation?.invitationId).filter(Boolean));
  return (Array.isArray(org?.members) ? org.members : []).filter((member) => {
    const memberEmail = normalizeEmail(member?.user?.email ?? member?.email);
    return memberEmail === normalized || (member?.inviteId && inviteIds.has(member.inviteId));
  });
}

async function listProviders(ctx) {
  const result = await adminRequest(ctx, "/v1/llm-providers?scope=manageable");
  return Array.isArray(result.body?.llmProviders) ? result.body.llmProviders : [];
}

async function deleteApprovedProviders(ctx, tolerateMissing) {
  const providers = await listProviders(ctx);
  for (const provider of providers.filter((entry) => entry?.name === PROVIDER_NAME)) {
    if (provider?.id) {
      await adminRequest(ctx, `/v1/llm-providers/${encodeURIComponent(provider.id)}`, { method: "DELETE" }, tolerateMissing ? [204, 404] : [204]);
    }
  }
}

async function getDefaultDesktopPolicy(ctx) {
  const result = await adminRequest(ctx, "/v1/desktop-policies");
  const policies = Array.isArray(result.body?.desktopPolicies) ? result.body.desktopPolicies : [];
  const policy = policies.find((entry) => entry?.isDefault === true) ?? null;
  ctx.assert(Boolean(policy?.id), "Default desktop policy exists.");
  state.defaultPolicyId = policy.id;
  return policy;
}

async function setDefaultDesktopPolicyValues(ctx, values) {
  const policy = await getDefaultDesktopPolicy(ctx);
  const body = {
    policyName: policy.policyName,
    policy: {
      ...(policy.policy ?? {}),
      allowCustomProviders: values.allowCustomProviders,
      allowZenModel: values.allowZenModel,
    },
    priority: policy.priority ?? 0,
    isEnabled: policy.isEnabled ?? true,
    memberIds: [],
    teamIds: [],
  };
  const result = await adminRequest(ctx, `/v1/desktop-policies/${encodeURIComponent(policy.id)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  return result.body?.desktopPolicy;
}

async function withClient(ctx, cdpBaseUrl, fn) {
  const previous = ctx.client;
  const target = await firstPageTarget(cdpBaseUrl);
  const client = await connect(debuggerUrlFor(cdpBaseUrl, target));
  ctx.client = client;
  try {
    await setDesktopViewport(ctx);
    return await fn();
  } finally {
    ctx.client = previous;
    try {
      client.close();
    } catch {
      // Socket already closed.
    }
  }
}

async function firstPageTarget(cdpBaseUrl) {
  const existing = await listTargets(cdpBaseUrl);
  const page = existing.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (page) return page;

  const base = cdpBaseUrl.replace(/\/+$/, "");
  let response = await fetch(`${base}/json/new?about:blank`, { method: "PUT" });
  if (!response.ok) response = await fetch(`${base}/json/new?about:blank`);
  if (!response.ok) throw new Error(`Could not create a page target at ${cdpBaseUrl}: ${response.status}`);
  const created = await response.json();
  if (created?.type === "page" && created.webSocketDebuggerUrl) return created;

  const targets = await listTargets(cdpBaseUrl);
  const nextPage = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (!nextPage) throw new Error(`No page target available at ${cdpBaseUrl}.`);
  return nextPage;
}

async function signInAdminBrowser(ctx) {
  if (!state.adminBrowserSignedIn) {
    await signInViaBrowser(ctx, ADMIN_EMAIL, ADMIN_PASSWORD);
    state.adminBrowserSignedIn = true;
  }

  await navigateAbsolute(ctx, denWebUrl());
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: "den-web root" });
  const selected = await ctx.eval(`(async () => {
    const response = await fetch('/api/auth/organization/set-active', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId: ${JSON.stringify(state.orgId)} }),
    });
    return { ok: response.ok, status: response.status, text: await response.text() };
  })()`, { awaitPromise: true });
  ctx.assert(selected?.ok, `Browser session could not switch to ${ORG_NAME}: ${selected?.status} ${String(selected?.text ?? "").slice(0, 200)}`);
  await selectAcmeFromChooserIfVisible(ctx);
}

async function selectAcmeFromChooserIfVisible(ctx) {
  const chooserVisible = await ctx.eval("Boolean(document.querySelector('[data-testid=\"org-chooser-root\"]'))");
  if (!chooserVisible) return false;

  await ctx.waitFor(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((entry) => (entry.innerText ?? '').includes(${JSON.stringify(ORG_NAME)}) && entry.disabled !== true);
    button?.scrollIntoView({ block: 'center', inline: 'center' });
    button?.click();
    return Boolean(button);
  })()`, { timeoutMs: 20_000, label: `${ORG_NAME} organization chooser option` });
  await ctx.waitFor("!document.querySelector('[data-testid=\"org-chooser-root\"]')", {
    timeoutMs: 30_000,
    label: `${ORG_NAME} organization selected`,
  });
  return true;
}

async function openAdminPage(ctx, path, expectedText) {
  await signInAdminBrowser(ctx);
  await navigateAbsolute(ctx, `${denWebUrl()}${path}`);
  if (await selectAcmeFromChooserIfVisible(ctx)) {
    await navigateAbsolute(ctx, `${denWebUrl()}${path}`);
  }
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: `load ${path}` });
  await ctx.waitForText(expectedText, { timeoutMs: 45_000 });
}

async function navigateAbsolute(ctx, url) {
  const marker = `ifb-nav-${Date.now()}-${Math.random()}`;
  await ctx.eval(`(() => { window.__ifbNavMarker = ${JSON.stringify(marker)}; return true; })()`);
  await ctx.client.send("Page.navigate", { url });
  await ctx.waitFor(`(() => {
    if (document.readyState !== 'complete') return false;
    return window.__ifbNavMarker !== ${JSON.stringify(marker)};
  })()`, { timeoutMs: 30_000, label: `navigate ${redactedUrlLabel(url)}` });
}

function redactedUrlLabel(url) {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has("invite")) parsed.searchParams.set("invite", "REDACTED");
    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return "page";
  }
}

async function clickExactText(ctx, text, selector) {
  await ctx.waitFor(`(() => {
    const normalize = (value) => (value ?? '').replace(/\\s+/g, ' ').trim();
    const candidates = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const element = candidates.find((candidate) => normalize(candidate.textContent) === ${JSON.stringify(text)} && candidate.disabled !== true && candidate.getAttribute('aria-disabled') !== 'true');
    element?.scrollIntoView({ block: 'center', inline: 'center' });
    element?.click();
    return Boolean(element);
  })()`, { timeoutMs: 20_000, label: `click ${text}` });
}

async function clickDefaultPolicyEdit(ctx) {
  await ctx.waitFor(`(() => {
    const rows = [...document.querySelectorAll('tr')];
    const row = rows.find((entry) => (entry.innerText ?? '').includes('Default'));
    const edit = [...(row?.querySelectorAll('a, button') ?? [])].find((entry) => (entry.textContent ?? '').trim() === 'Edit');
    edit?.scrollIntoView({ block: 'center', inline: 'center' });
    edit?.click();
    return Boolean(edit);
  })()`, { timeoutMs: 20_000, label: "default policy Edit link" });
}

async function setPolicyCheckbox(ctx, label, checked) {
  const result = await ctx.waitFor(`(() => {
    const labelText = ${JSON.stringify(label)};
    const desired = ${JSON.stringify(checked)};
    const labels = [...document.querySelectorAll('label')];
    const row = labels.find((entry) => (entry.innerText ?? '').includes(labelText));
    const input = row?.querySelector('input[type="checkbox"]');
    if (!input) return null;
    input.scrollIntoView({ block: 'center', inline: 'center' });
    if (input.checked !== desired) input.click();
    return { found: true, checked: input.checked };
  })()`, { timeoutMs: 20_000, label: `${label} checkbox` });
  ctx.assert(result?.checked === checked, `${label} checkbox should be ${checked ? "checked" : "unchecked"}.`);
}

async function waitForPolicyCheckbox(ctx, label, checked) {
  await ctx.waitFor(`(() => {
    const row = [...document.querySelectorAll('label')].find((entry) => (entry.innerText ?? '').includes(${JSON.stringify(label)}));
    const input = row?.querySelector('input[type="checkbox"]');
    return Boolean(input) && input.checked === ${JSON.stringify(checked)};
  })()`, { timeoutMs: 20_000, label: `${label} saved checkbox state` });
}

async function assertPolicyCheckbox(ctx, label, checked) {
  const actual = await ctx.eval(`(() => {
    const row = [...document.querySelectorAll('label')].find((entry) => (entry.innerText ?? '').includes(${JSON.stringify(label)}));
    const input = row?.querySelector('input[type="checkbox"]');
    return input ? input.checked : null;
  })()`);
  ctx.assert(actual === checked, `${label} UI checkbox is ${checked ? "checked" : "unchecked"}.`);
}

async function ensureCatalogModelsExist(ctx) {
  const result = await adminRequest(ctx, "/v1/llm-provider-catalog/openai");
  const models = Array.isArray(result.body?.provider?.models) ? result.body.provider.models : [];
  const ids = models.map((model) => model?.id).filter(Boolean);
  const missing = MODEL_IDS.filter((id) => !ids.includes(id));
  if (missing.length > 0) {
    const gpt5 = ids.filter((id) => String(id).startsWith("gpt-5.")).sort();
    ctx.assert(false, `OpenAI catalog is missing ${missing.join(", ")}. Available gpt-5.* ids: ${gpt5.join(", ") || "none"}`);
  }
}

async function createApprovedModelProvider(ctx) {
  const result = await adminRequest(ctx, "/v1/llm-providers", {
    method: "POST",
    body: JSON.stringify({
      name: PROVIDER_NAME,
      source: "models_dev",
      providerId: "openai",
      modelIds: MODEL_IDS,
      apiKey: orgModelApiKey(),
      memberIds: [],
      teamIds: [state.engineeringTeamId],
    }),
  });
  const provider = result.body?.llmProvider;
  ctx.assert(Boolean(provider?.id), `${PROVIDER_NAME} create response included a provider id.`);
  return provider;
}

async function assertApprovedProvider(ctx) {
  const providers = (await listProviders(ctx)).filter((provider) => provider?.name === PROVIDER_NAME);
  ctx.assert(providers.length === 1, `Expected exactly one ${PROVIDER_NAME} provider, found ${providers.length}.`);
  const provider = providers[0];
  const modelIds = (Array.isArray(provider.models) ? provider.models : []).map((model) => model?.id).sort();
  ctx.assert(provider.hasApiKey === true, `${PROVIDER_NAME} has a saved credential.`);
  ctx.assert(modelIds.length === 2 && MODEL_IDS.every((id) => modelIds.includes(id)), `${PROVIDER_NAME} exposes exactly ${MODEL_IDS.join(" and ")}.`);
  const teams = Array.isArray(provider.access?.teams) ? provider.access.teams : [];
  ctx.assert(teams.some((team) => team?.id === state.engineeringTeamId || team?.name === ENGINEERING_TEAM), `${PROVIDER_NAME} grants access to Engineering.`);
  return provider;
}

async function installInvitationCapture(ctx) {
  await ctx.eval(`(() => {
    window.__ifbInvitationCapture = null;
    if (window.__ifbOriginalFetch) return true;
    window.__ifbOriginalFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const response = await window.__ifbOriginalFetch(input, init);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input?.url ?? '';
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (method === 'POST' && url.includes('/v1/invitations')) {
        try {
          window.__ifbInvitationCapture = { status: response.status, body: await response.clone().json() };
        } catch {
          window.__ifbInvitationCapture = { status: response.status, body: null };
        }
      }
      return response;
    };
    return true;
  })()`);
}

async function setInviteRole(ctx, role) {
  await ctx.eval(`(() => {
    const select = [...document.querySelectorAll('select')]
      .find((entry) => [...entry.options].some((option) => option.value === ${JSON.stringify(role)}));
    if (!select) return false;
    select.value = ${JSON.stringify(role)};
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
}

async function selectInviteEngineeringIfPresent(ctx) {
  return Boolean(await ctx.eval(`(() => {
    const teamName = ${JSON.stringify(ENGINEERING_TEAM)};
    const selects = [...document.querySelectorAll('select')];
    const select = selects.find((entry) => [...entry.options].some((option) => (option.textContent ?? '').trim() === teamName));
    if (select) {
      const option = [...select.options].find((entry) => (entry.textContent ?? '').trim() === teamName);
      select.value = option.value;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    const candidates = [...document.querySelectorAll('button, label')].filter((entry) => (entry.innerText ?? '').includes(teamName));
    const target = candidates.find((entry) => {
      const input = entry.matches('label') ? entry.querySelector('input') : null;
      return !input || input.checked === false;
    });
    target?.scrollIntoView({ block: 'center', inline: 'center' });
    target?.click();
    return Boolean(target);
  })()`));
}

async function assertPendingMayaInvitation(ctx) {
  const org = await loadOrg(ctx);
  const invitation = invitationsForEmail(org, MAYA_EMAIL).find((entry) => entry?.status === "pending") ?? null;
  ctx.assert(Boolean(invitation), `No pending invitation for ${MAYA_EMAIL}.`);
  const member = membersForEmailOrInvite(org, MAYA_EMAIL, [invitation]).find((entry) => !entry?.joinedAt) ?? null;
  ctx.assert(Boolean(member?.id), `No pending member row for ${MAYA_EMAIL}.`);
  const engineeringTeam = engineeringTeamFromOrg(ctx, org);
  return { org, invitation, member, engineeringTeam };
}

async function assignMayaInviteToEngineering(ctx) {
  const { member, engineeringTeam } = await assertPendingMayaInvitation(ctx);
  const memberIds = Array.isArray(engineeringTeam.memberIds) ? engineeringTeam.memberIds : [];
  if (memberIds.includes(member.id)) return;
  const nextMemberIds = [...memberIds, member.id];
  await adminRequest(ctx, `/v1/teams/${encodeURIComponent(engineeringTeam.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ name: engineeringTeam.name, memberIds: nextMemberIds }),
  });
}

function inviteUrl(ctx) {
  ctx.assert(Boolean(state.inviteToken), "Maya invite token was captured before frame 4.");
  return `${denWebUrl()}/join-org?invite=${encodeURIComponent(state.inviteToken)}`;
}

async function clearDenWebSession(ctx) {
  await ctx.client.send("Network.clearBrowserCookies").catch(() => undefined);
  await navigateAbsolute(ctx, denWebUrl());
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: "den-web root loaded" });
  await ctx.eval(`(async () => {
    try {
      await fetch('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    } catch {}
    localStorage.clear();
    sessionStorage.clear();
    return true;
  })()`, { awaitPromise: true });
}

async function assertJoinInvitationDetails(ctx) {
  const details = await ctx.eval(`(() => {
    const root = document.querySelector('[data-testid="join-org-root"]');
    const details = document.querySelector('[data-testid="join-org-invitation-details"]');
    return { state: root?.getAttribute('data-state') ?? '', text: details?.innerText ?? '' };
  })()`);
  ctx.assert(details?.state === "signed-out", `Join page state is signed-out (actual: ${details?.state}).`);
  ctx.assert(details.text.includes(ORG_NAME), "Join invitation details show Acme Robotics.");
  ctx.assert(details.text.includes(MAYA_EMAIL), "Join invitation details show Maya's invited email.");
  ctx.assert(details.text.includes("Member"), "Join invitation details show the member role.");
}

async function inviteeCanSignIn(ctx) {
  const result = await denApiAuthRequest("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email: MAYA_EMAIL, password: MAYA_PASSWORD }),
  });
  if (result.response.ok) return true;
  if (result.response.status === 401 || result.response.status === 403 || result.response.status === 404 || result.response.status === 422) return false;
  ctx.assert(false, `Could not check whether ${MAYA_EMAIL} already exists: ${result.response.status} ${safeBody(result.body)}`);
  return false;
}

async function completeMayaJoin(ctx) {
  await ctx.waitFor("Boolean(document.querySelector('input[type=\"password\"]'))", { timeoutMs: 30_000, label: "join password field" });
  if (state.inviteeHadExistingAccount) {
    await clickExactText(ctx, "Sign in", "button");
    await ctx.waitForText("Sign in to continue.", { timeoutMs: 10_000 });
  }
  await ctx.fill('input[type="password"]', MAYA_PASSWORD);
  await clickButtonStartingWithOneOf(ctx, ["Join Acme Robotics", "Sign in to join", "Sign in"], 30_000);
  await ctx.waitFor(`(() => {
    const text = document.body.innerText || '';
    return Boolean(document.querySelector('[data-testid="join-org-success"]'))
      || text.includes("You're one click away from the team workspace.")
      || text.includes('Check your inbox.')
      || text.includes('Verification code');
  })()`, { timeoutMs: 60_000, label: "join auth result" });

  const verificationBlocked = await ctx.eval(`(() => {
    const text = document.body.innerText || '';
    return text.includes('Check your inbox.') || text.includes('Verification code');
  })()`);
  if (verificationBlocked) {
    markEmailVerified(MAYA_EMAIL);
    state.inviteeHadExistingAccount = true;
    await navigateAbsolute(ctx, inviteUrl(ctx));
    await ctx.waitFor("document.querySelector('[data-testid=\"join-org-root\"]')?.getAttribute('data-state') === 'signed-out'", {
      timeoutMs: 30_000,
      label: "join screen after verification",
    });
    await clickExactText(ctx, "Sign in", "button");
    await ctx.waitFor("Boolean(document.querySelector('input[type=\"password\"]'))", { timeoutMs: 20_000, label: "sign-in password field" });
    await ctx.fill('input[type="password"]', MAYA_PASSWORD);
    await clickButtonStartingWithOneOf(ctx, ["Sign in to join", "Sign in"], 30_000);
  }

  await ctx.waitFor(`(() => {
    const text = document.body.innerText || '';
    return Boolean(document.querySelector('[data-testid="join-org-success"]')) || text.includes("You're one click away from the team workspace.");
  })()`, { timeoutMs: 60_000, label: "signed-in invite confirmation or success" });

  const alreadySuccess = await ctx.eval("Boolean(document.querySelector('[data-testid=\"join-org-success\"]'))");
  if (!alreadySuccess) {
    markEmailVerified(MAYA_EMAIL);
    await clickButtonStartingWithOneOf(ctx, ["Join Acme Robotics"], 30_000);
  }
  await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"join-org-success\"]'))", { timeoutMs: 60_000, label: "join success" });
  await ctx.waitForText("Get the desktop app", { timeoutMs: 30_000 });
}

async function clickButtonStartingWithOneOf(ctx, prefixes, timeoutMs) {
  await ctx.waitFor(`(() => {
    const normalize = (value) => (value ?? '').replace(/\\s+/g, ' ').trim();
    const prefixes = ${JSON.stringify(prefixes)};
    const buttons = [...document.querySelectorAll('button')]
      .filter((entry) => entry.disabled !== true && entry.getAttribute('aria-disabled') !== 'true')
      .sort((left, right) => Number(right.type === 'submit') - Number(left.type === 'submit'));
    const button = buttons.find((entry) => prefixes.some((prefix) => normalize(entry.textContent).startsWith(prefix)));
    button?.scrollIntoView({ block: 'center', inline: 'center' });
    button?.click();
    return Boolean(button);
  })()`, { timeoutMs, label: `button starting with ${prefixes.join(" or ")}` });
}

function markEmailVerified(email) {
  if (!MARK_VERIFIED_CMD) return;
  execSync(MARK_VERIFIED_CMD.replaceAll("{email}", email), { stdio: "ignore" });
}

async function assertMayaAcceptedAndActive(ctx) {
  const org = await loadOrg(ctx);
  const invitation = invitationsForEmail(org, MAYA_EMAIL).find((entry) => entry?.status === "accepted") ?? null;
  ctx.assert(Boolean(invitation), `Invitation for ${MAYA_EMAIL} is accepted.`);
  const activeMember = membersForEmailOrInvite(org, MAYA_EMAIL, invitation ? [invitation] : []).find((member) => Boolean(member?.joinedAt));
  ctx.assert(Boolean(activeMember?.id), `${MAYA_EMAIL} is an active organization member.`);
  const engineeringTeam = engineeringTeamFromOrg(ctx, org);
  ctx.assert(engineeringTeam.memberIds.includes(activeMember.id), `${MAYA_EMAIL} remains in Engineering after accepting the invite.`);
}

async function redactInviteCredentialInPage(ctx) {
  await ctx.eval(`(() => {
    const token = ${JSON.stringify(state.inviteToken)};
    const url = new URL(location.href);
    if (url.searchParams.has('invite')) {
      url.searchParams.set('invite', 'REDACTED');
      history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const before = node.nodeValue ?? '';
      let after = before.replace(/([?&]invite=)[^&\\s<>"]+/g, '$1REDACTED');
      if (token) after = after.split(token).join('REDACTED');
      if (after !== before) node.nodeValue = after;
      node = walker.nextNode();
    }
    for (const input of document.querySelectorAll('input[readonly]')) {
      if (!(input instanceof HTMLInputElement)) continue;
      try {
        const inputUrl = new URL(input.value);
        if (inputUrl.searchParams.has('invite')) {
          inputUrl.searchParams.set('invite', 'REDACTED');
          const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
          descriptor?.set?.call(input, inputUrl.toString());
          input.setAttribute('value', inputUrl.toString());
        }
      } catch {}
    }
    return true;
  })()`);
}

async function setDesktopViewport(ctx) {
  if (!ctx.client?.send) return;
  try {
    await ctx.client.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
  } catch (error) {
    ctx.log(`Desktop viewport skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function setInputCheckedByTestId(ctx, testId, checked) {
  const result = await ctx.waitFor(`(() => {
    const input = document.querySelector('[data-testid="${testId}"]');
    if (!(input instanceof HTMLInputElement)) return false;
    const target = input.closest('label') ?? input;
    target.scrollIntoView({ block: 'center', inline: 'center' });
    if (input.checked !== ${JSON.stringify(checked)}) target.click();
    return input.checked === ${JSON.stringify(checked)} ? { checked: input.checked, disabled: input.disabled } : false;
  })()`, { timeoutMs: 20_000, label: `${testId} ${checked ? "checked" : "unchecked"}` });
  ctx.assert(result?.checked === checked, `${testId} should be ${checked ? "checked" : "unchecked"}; got ${JSON.stringify(result)}.`);
}

async function setModelAccessCard(ctx, { mode, adminException, zenAllowed }) {
  await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"models-access-card\"]'))", {
    timeoutMs: 30_000,
    label: "models access card",
  });
  await setInputCheckedByTestId(ctx, mode === "managed" ? "models-access-managed" : "models-access-open", true);
  if (mode === "managed") {
    await setInputCheckedByTestId(ctx, "models-access-admin-exception", adminException);
    await setInputCheckedByTestId(ctx, "models-access-zen", zenAllowed);
  }
  await ctx.waitFor(`(() => {
    const button = document.querySelector('[data-testid="models-access-save"]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.scrollIntoView({ block: 'center', inline: 'center' });
    button.click();
    return true;
  })()`, { timeoutMs: 20_000, label: "save model access card" });
  await ctx.waitFor(`(() => {
    const text = document.querySelector('[data-testid="models-access-card"]')?.innerText ?? '';
    const managed = document.querySelector('[data-testid="models-access-managed"]');
    const zen = document.querySelector('[data-testid="models-access-zen"]');
    const admin = document.querySelector('[data-testid="models-access-admin-exception"]');
    return text.includes('Model access saved.')
      && managed instanceof HTMLInputElement && managed.checked === ${JSON.stringify(mode === "managed")}
      && zen instanceof HTMLInputElement && zen.checked === ${JSON.stringify(zenAllowed)}
      && admin instanceof HTMLInputElement && admin.checked === ${JSON.stringify(adminException)};
  })()`, { timeoutMs: 30_000, label: "saved model access state" });
}

async function assertModelAccessCard(ctx, { mode, adminException, zenAllowed }) {
  const state = await ctx.eval(`(() => {
    const checked = (testId) => {
      const input = document.querySelector('[data-testid="' + testId + '"]');
      return input instanceof HTMLInputElement ? input.checked : null;
    };
    return {
      open: checked('models-access-open'),
      managed: checked('models-access-managed'),
      adminException: checked('models-access-admin-exception'),
      zenAllowed: checked('models-access-zen'),
      outcome: document.querySelector('[data-testid="models-access-outcome"]')?.textContent ?? '',
      saved: (document.querySelector('[data-testid="models-access-card"]')?.innerText ?? '').includes('Model access saved.'),
    };
  })()`);
  ctx.output("frame-1-model-access-card", JSON.stringify(state, null, 2));
  ctx.assert(state?.managed === (mode === "managed"), `Models access managed radio state mismatch: ${JSON.stringify(state)}.`);
  ctx.assert(state?.open === (mode === "open"), `Models access open radio state mismatch: ${JSON.stringify(state)}.`);
  ctx.assert(state?.adminException === adminException, `Admin exception checkbox mismatch: ${JSON.stringify(state)}.`);
  ctx.assert(state?.zenAllowed === zenAllowed, `Zen checkbox mismatch: ${JSON.stringify(state)}.`);
  ctx.assert(state?.saved === true, `Model access card did not show saved state: ${JSON.stringify(state)}.`);
}

async function openInstallGuideFromJoinSuccess(ctx) {
  await ctx.waitForText("Get the desktop app", { timeoutMs: 30_000 });
  await ctx.clickText("Get the desktop app", { selector: "button", timeoutMs: 30_000 });
  await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"install-page\"]'))", {
    timeoutMs: 45_000,
    label: "install guide page",
  });
  await ctx.waitForText("Download the OpenWork installer", { timeoutMs: 30_000 });
  await ctx.eval(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((entry) => (entry.textContent ?? '').includes('I already have OpenWork'));
    button?.scrollIntoView({ block: 'center', inline: 'center' });
    button?.click();
    return Boolean(button);
  })()`);
  await ctx.waitForText("Open OpenWork", { timeoutMs: 30_000 });
}

async function signInMayaByEmail(ctx) {
  const result = await denApiAuthRequest("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email: MAYA_EMAIL, password: MAYA_PASSWORD }),
  });
  ctx.assert(result.response.ok, `Maya sign-in failed: ${result.response.status} ${safeBody(result.body)}`);
  const token = result.body?.token;
  ctx.assert(typeof token === "string" && token.trim().length > 0, "Maya sign-in returned a bearer token.");
  return token.trim();
}

async function getOpenworkServerInfo(ctx) {
  await ctx.waitFor("Boolean(window.__OPENWORK_ELECTRON__?.invokeDesktop)", {
    timeoutMs: 60_000,
    label: "desktop bridge",
  });
  const info = await ctx.eval("window.__OPENWORK_ELECTRON__.invokeDesktop('openworkServerInfo')", { awaitPromise: true });
  const baseUrl = String(info?.baseUrl || info?.connectUrl || (info?.port ? `http://127.0.0.1:${info.port}` : "")).replace(/\/+$/, "");
  const token = String(info?.clientToken || info?.ownerToken || "").trim();
  const hostToken = String(info?.hostToken || "").trim();
  ctx.assert(Boolean(baseUrl), "OpenWork server base URL is available.");
  ctx.assert(Boolean(token), "OpenWork server client token is available.");
  return { baseUrl, token, hostToken };
}

async function openworkRequest(ctx, path, options = {}) {
  const info = await getOpenworkServerInfo(ctx);
  const headers = {
    ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
    authorization: `Bearer ${info.token}`,
    ...(options.host === true && info.hostToken ? { "x-openwork-host-token": info.hostToken } : {}),
    ...(options.headers ?? {}),
  };
  const request = {
    url: `${info.baseUrl}${path}`,
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  };
  const result = await ctx.eval(`(async () => {
    const request = ${JSON.stringify(request)};
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { ok: response.ok, status: response.status, statusText: response.statusText, text, body, url: request.url };
  })()`, { awaitPromise: true });
  return { response: { ok: result.ok, status: result.status, statusText: result.statusText }, text: result.text, body: result.body, url: result.url };
}

async function expectOpenworkJson(ctx, path, options = {}) {
  const result = await openworkRequest(ctx, path, options);
  ctx.assert(result.response.ok, `${options.method ?? "GET"} ${path} failed: ${result.response.status} ${safeBody(result.body)}`);
  return result.body;
}

function workspaceItems(payload) {
  return Array.isArray(payload?.items)
    ? payload.items
    : Array.isArray(payload?.workspaces)
      ? payload.workspaces
      : [];
}

async function ensureEvalWorkspace(ctx) {
  const workspacePath = "/tmp/openwork-invitee-first-boot-workspace";
  const list = await expectOpenworkJson(ctx, "/workspaces");
  let workspace = workspaceItems(list).find((item) => item?.path === workspacePath || item?.name === "Invitee first boot eval") ?? null;
  if (!workspace) {
    const created = await expectOpenworkJson(ctx, "/workspaces/local", {
      method: "POST",
      host: true,
      body: {
        folderPath: workspacePath,
        name: "Invitee first boot eval",
        preset: "starter",
      },
    });
    workspace = workspaceItems(created).find((item) => item?.path === workspacePath)
      ?? workspaceItems(created).find((item) => item?.id === created?.activeId)
      ?? null;
  }

  const workspaceId = String(workspace?.id ?? "").trim();
  ctx.assert(Boolean(workspaceId), `Could not create/find eval workspace at ${workspacePath}.`);
  state.desktopWorkspaceId = workspaceId;
  await ctx.eval(`(async () => {
    const workspaceId = ${JSON.stringify(workspaceId)};
    await window.__OPENWORK_ELECTRON__?.invokeDesktop?.('workspaceSetSelected', workspaceId);
    await window.__OPENWORK_ELECTRON__?.invokeDesktop?.('workspaceSetRuntimeActive', workspaceId);
    localStorage.setItem('openwork.react.activeWorkspace', workspaceId);
    location.hash = '#/workspace/' + encodeURIComponent(workspaceId) + '/session';
    return true;
  })()`, { awaitPromise: true });
  return { workspaceId, workspacePath };
}

async function workspaceConfigRequest(ctx, method, body) {
  const workspaceId = state.desktopWorkspaceId || (await ensureEvalWorkspace(ctx)).workspaceId;
  return expectOpenworkJson(ctx, `/workspace/${encodeURIComponent(workspaceId)}/config`, {
    method,
    body,
  });
}

function runtimeProviderDeletes(opencode) {
  const provider = opencode?.provider && typeof opencode.provider === "object" ? opencode.provider : {};
  return Object.fromEntries(
    Object.keys(provider)
      .filter((key) => key.startsWith("lpr_"))
      .map((key) => [key, null]),
  );
}

async function resetDesktopToColdFirstBoot(ctx) {
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API before cold reset" });
  await ctx.eval(`window.__OPENWORK_ELECTRON__?.invokeDesktop?.('setDesktopBootstrapConfig', {
    baseUrl: ${JSON.stringify(denWebUrl())},
    apiBaseUrl: ${JSON.stringify(denApiUrl())},
    requireSignin: false,
    handoff: null,
  })`, { awaitPromise: true });
  const { workspaceId, workspacePath } = await ensureEvalWorkspace(ctx);
  const current = await workspaceConfigRequest(ctx, "GET");
  const providerDeletes = runtimeProviderDeletes(current?.opencode);
  const cloudImports = current?.openwork?.cloudImports && typeof current.openwork.cloudImports === "object"
    ? current.openwork.cloudImports
    : {};

  await workspaceConfigRequest(ctx, "PATCH", {
    opencode: {
      disabled_providers: [],
      ...(Object.keys(providerDeletes).length > 0 ? { provider: providerDeletes } : {}),
    },
    openwork: {
      cloudImports: { ...cloudImports, providers: {} },
    },
  });
  await startDesktopEngine(ctx, workspacePath);

  await ctx.eval(`(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('openwork.den.') && key !== 'openwork.den.baseUrl' && key !== 'openwork.den.apiBaseUrl') localStorage.removeItem(key);
      if (key.startsWith('openwork.sessionModels.')) localStorage.removeItem(key);
      if (key.startsWith('openwork.modelVariant.')) localStorage.removeItem(key);
    }
    localStorage.setItem('openwork.den.baseUrl', ${JSON.stringify(denWebUrl())});
    localStorage.setItem('openwork.den.apiBaseUrl', ${JSON.stringify(denApiUrl())});
    localStorage.removeItem('openwork.preferences');
    localStorage.removeItem('openwork.defaultModel');
    localStorage.removeItem('openwork.policy.disabledProviders');
    localStorage.removeItem('openwork.seenProviderIds');
    sessionStorage.removeItem('__owFirstBootArmed');
    sessionStorage.removeItem('__owFirstBootReloads');
    sessionStorage.removeItem('__owFirstBootCounters');
    sessionStorage.removeItem('__owFirstBootDialogs');
    localStorage.setItem('openwork.react.activeWorkspace', ${JSON.stringify(workspaceId)});
    location.hash = '#/workspace/' + encodeURIComponent(${JSON.stringify(workspaceId)}) + '/session';
    return true;
  })()`);
  await ctx.client.send("Page.reload", { ignoreCache: true });
  await ctx.waitFor("Boolean(window.__openworkControl)", {
    timeoutMs: 90_000,
    label: "control API after cold reset reload",
  });
  await ctx.waitFor(`localStorage.getItem('openwork.react.activeWorkspace') === ${JSON.stringify(workspaceId)}`, {
    timeoutMs: 10_000,
    label: "active workspace retained after cold reset",
  });
}

async function startDesktopEngine(ctx, workspacePath) {
  const result = await ctx.eval(`window.__OPENWORK_ELECTRON__?.invokeDesktop?.('engineStart', ${JSON.stringify(workspacePath)}, {
    runtime: 'direct',
    workspacePaths: [${JSON.stringify(workspacePath)}],
    openworkRemoteAccess: false,
  })`, { awaitPromise: true });
  ctx.output("frame-5-engine-start", JSON.stringify({ baseUrlSet: Boolean(result?.baseUrl), error: result?.error ?? null }, null, 2));
  let last = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    last = await openworkRequest(ctx, `/workspace/${encodeURIComponent(state.desktopWorkspaceId)}/opencode/global/health`).catch((error) => ({
      response: { ok: false, status: 0 },
      body: error instanceof Error ? error.message : String(error),
    }));
    if (last?.response?.ok) return;
    await sleep(500);
  }
  ctx.assert(false, `OpenCode health did not become ready before first-boot handoff: ${last?.response?.status ?? "no response"} ${safeBody(last?.body)}`);
}

async function armFirstBootProbe(ctx) {
  await ctx.eval(`(() => {
    const armedKey = '__owFirstBootArmed';
    const reloadKey = '__owFirstBootReloads';
    const countersKey = '__owFirstBootCounters';
    const dialogsKey = '__owFirstBootDialogs';
    const startedAt = performance.now();
    sessionStorage.setItem(armedKey, '1');
    sessionStorage.setItem(reloadKey, '0');
    sessionStorage.setItem(countersKey, JSON.stringify({ engineReloads: 0, configWrites: 0, runtimeConfigWrites: 0, cloudSyncCalls: 0 }));
    sessionStorage.setItem(dialogsKey, '[]');

    const dedupe = new Set();
    const counters = { engineReloads: 0, configWrites: 0, runtimeConfigWrites: 0, cloudSyncCalls: 0 };
    const dialogs = [];
    const persist = () => {
      sessionStorage.setItem(countersKey, JSON.stringify(counters));
      sessionStorage.setItem(dialogsKey, JSON.stringify(dialogs));
    };
    const titleFor = (element) => {
      const title = element.querySelector('[data-slot="dialog-title"], [role="heading"], h1, h2, h3');
      return (title?.innerText || title?.textContent || '').replace(/\\s+/g, ' ').trim();
    };
    const scan = (root) => {
      const nodes = [];
      if (root?.matches?.('[role="dialog"], [data-slot="dialog"], [data-testid*="dialog"]')) nodes.push(root);
      nodes.push(...(root?.querySelectorAll?.('[role="dialog"], [data-slot="dialog"], [data-testid*="dialog"]') ?? []));
      for (const element of nodes) {
        const rect = element.getBoundingClientRect?.();
        const text = (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim();
        if (!text || rect?.width === 0 || rect?.height === 0) continue;
        const entry = {
          atMs: Math.round(performance.now() - startedAt),
          testid: element.getAttribute('data-testid') || '',
          title: titleFor(element),
          text: text.slice(0, 300),
        };
        const key = [entry.testid, entry.title, entry.text].join('|');
        if (dedupe.has(key)) continue;
        dedupe.add(key);
        dialogs.push(entry);
      }
      persist();
    };

    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const requestUrl = typeof args[0] === 'string'
        ? args[0]
        : args[0] instanceof URL
          ? args[0].toString()
          : args[0]?.url ?? '';
      const method = String(args[1]?.method ?? (args[0] instanceof Request ? args[0].method : 'GET')).toUpperCase();
      if (requestUrl.includes('/engine/reload') || requestUrl.includes('/engine/restart')) counters.engineReloads += 1;
      if (method === 'PATCH' && requestUrl.includes('/workspace/') && requestUrl.endsWith('/config')) counters.configWrites += 1;
      if (requestUrl.includes('/runtime-config/')) counters.runtimeConfigWrites += 1;
      if (requestUrl.includes('/desktop-cloud-sync')) counters.cloudSyncCalls += 1;
      persist();
      return originalFetch(...args);
    };

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof Element) scan(node);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    scan(document.body);
    window.addEventListener('beforeunload', () => {
      const current = Number(sessionStorage.getItem(reloadKey) || '0');
      sessionStorage.setItem(reloadKey, String(current + 1));
      persist();
    }, { once: false });
    window.__owFirstBoot = { startedAt, counters, dialogs, observer, persist };
    return true;
  })()`);
}

async function readFirstBootProbe(ctx) {
  const probe = await ctx.eval(`(() => {
    const parse = (key, fallback) => {
      try { return JSON.parse(sessionStorage.getItem(key) || JSON.stringify(fallback)); } catch { return fallback; }
    };
    const live = window.__owFirstBoot ?? null;
    return {
      armedMarker: sessionStorage.getItem('__owFirstBootArmed') === '1',
      live: Boolean(live),
      pageReloadsAfterArming: Number(sessionStorage.getItem('__owFirstBootReloads') || '0'),
      counters: live?.counters ?? parse('__owFirstBootCounters', { engineReloads: 0, configWrites: 0, runtimeConfigWrites: 0, cloudSyncCalls: 0 }),
      dialogs: live?.dialogs ?? parse('__owFirstBootDialogs', []),
    };
  })()`);
  return {
    armedMarker: Boolean(probe?.armedMarker),
    live: Boolean(probe?.live),
    pageReloadsAfterArming: Number(probe?.pageReloadsAfterArming ?? 0),
    counters: {
      engineReloads: Number(probe?.counters?.engineReloads ?? 0),
      configWrites: Number(probe?.counters?.configWrites ?? 0),
      runtimeConfigWrites: Number(probe?.counters?.runtimeConfigWrites ?? 0),
      cloudSyncCalls: Number(probe?.counters?.cloudSyncCalls ?? 0),
    },
    dialogs: Array.isArray(probe?.dialogs) ? probe.dialogs : [],
  };
}

async function freezeFirstBootDialogRecorder(ctx) {
  await ctx.eval(`(() => {
    window.__owFirstBoot?.persist?.();
    window.__owFirstBoot?.observer?.disconnect?.();
    return true;
  })()`);
}

async function readDesktopSessionState(ctx) {
  const desktop = await ctx.eval(`(() => {
    const hash = window.location.hash;
    const match = new RegExp('^#/workspace/([^/?#]+)/session(?:/(ses_[^/?#]+))?').exec(hash);
    const editor = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)});
    return {
      authTokenSet: Boolean((localStorage.getItem('openwork.den.authToken') ?? '').trim()),
      activeOrgId: localStorage.getItem('openwork.den.activeOrgId') || '',
      activeOrgName: localStorage.getItem('openwork.den.activeOrgName') || '',
      hash,
      workspaceId: match?.[1] ? decodeURIComponent(match[1]) : '',
      sessionId: match?.[2] ? decodeURIComponent(match[2]) : '',
      usableSessionRoute: Boolean(match),
      hasComposer: Boolean(editor),
      bodyText: (document.body.innerText || '').slice(0, 1200),
    };
  })()`);
  if (desktop?.workspaceId) state.desktopWorkspaceId = desktop.workspaceId;
  if (desktop?.sessionId) state.desktopSessionId = desktop.sessionId;
  return desktop;
}

async function clickFirstBootOnboardingIfVisible(ctx) {
  return ctx.eval(`(() => {
    const normalize = (value) => (value ?? '').replace(/\\s+/g, ' ').trim();
    const body = document.body.innerText || '';
    const visibleEnabled = (element) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
        && element.disabled !== true && element.getAttribute('aria-disabled') !== 'true';
    };
    const clickButton = (label) => {
      const button = [...document.querySelectorAll('button, [role="button"]')]
        .find((entry) => normalize(entry.textContent) === label && visibleEnabled(entry));
      button?.scrollIntoView({ block: 'center', inline: 'center' });
      button?.click();
      return Boolean(button);
    };
    for (const label of ['Continue with organization', 'Continue to workspace', 'Restart OpenWork']) {
      if (clickButton(label)) return label;
    }
    if (body.includes('Choose your organization')) {
      const org = [...document.querySelectorAll('label, button, [role="button"], [role="radio"]')]
        .find((entry) => normalize(entry.textContent).includes(${JSON.stringify(ORG_NAME)}) && visibleEnabled(entry));
      org?.scrollIntoView({ block: 'center', inline: 'center' });
      org?.click();
      if (org) return 'Choose your organization';
    }
    return '';
  })()`);
}

async function waitForFirstBootWorkspace(ctx, deliveredAt, timeoutMs) {
  const onboarding = { count: 0, labels: [] };
  const deadline = deliveredAt + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readDesktopSessionState(ctx).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
    if (last?.authTokenSet && last.activeOrgId && last.usableSessionRoute && last.hasComposer) {
      return { elapsedMs: Date.now() - deliveredAt, onboarding, desktop: last };
    }
    const clicked = await clickFirstBootOnboardingIfVisible(ctx).catch(() => "");
    if (clicked) {
      onboarding.count += 1;
      onboarding.labels.push(clicked);
      await sleep(1_000);
      continue;
    }
    await sleep(500);
  }
  ctx.output("frame-5-first-boot-timeout-state", JSON.stringify({ last, onboarding }, null, 2));
  ctx.assert(false, `First desktop boot did not reach composer-ready within ${timeoutMs}ms. Last state: ${JSON.stringify(last)}`);
}

async function ensureSessionReady(ctx) {
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 90_000, label: "control API" });
  await ctx.waitFor(`(() => {
    const hash = window.location.hash;
    return new RegExp('^#/workspace/[^/?#]+/session(?:/ses_[^/?#]+)?').test(hash)
      && Boolean(document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}))
      && document.body.innerText.includes('Run task');
  })()`, { timeoutMs: 90_000, label: "usable workspace session" });
  return readDesktopSessionState(ctx);
}

async function openModelPicker(ctx) {
  await ensureSessionReady(ctx);
  await ctx.waitFor("window.__openworkControl?.listActions?.().some((action) => action.id === 'session.model_picker.open' && !action.disabled)", {
    timeoutMs: 60_000,
    label: "session.model_picker.open enabled",
  });
  await ctx.control("session.model_picker.open");
  await ctx.waitForText("Models", { timeoutMs: 30_000 });
}

async function expandModelPickerGroups(ctx) {
  await ctx.eval(`(() => {
    const dialog = document.querySelector('[role="dialog"], [data-slot="dialog"]');
    if (!dialog) return false;
    const headers = [...dialog.querySelectorAll('button')]
      .filter((button) => /\\b\\d+ models?\\b/.test(button.textContent ?? ''));
    for (const header of headers) {
      const outer = header.parentElement?.parentElement;
      const hasRows = Boolean(outer?.querySelector('div.ml-9 button'));
      if (!hasRows) header.click();
    }
    return headers.length > 0;
  })()`);
}

async function readEngineProviderList(ctx, workspaceId = state.desktopWorkspaceId) {
  const result = await openworkRequest(ctx, `/workspace/${encodeURIComponent(workspaceId)}/opencode/provider`);
  ctx.assert(result.response.ok, `GET /provider through workspace proxy failed: ${result.response.status} ${safeBody(result.body)}`);
  return result.body;
}

function providerItems(providerList) {
  return Array.isArray(providerList?.all) ? providerList.all : [];
}

function connectedProviderIds(providerList) {
  return Array.isArray(providerList?.connected)
    ? providerList.connected.filter((item) => typeof item === "string")
    : [];
}

function resolveRenderedProviderId(providerList, providerLabel, modelId) {
  const connected = new Set(connectedProviderIds(providerList));
  const items = providerItems(providerList).filter((provider) => Boolean(provider?.models?.[modelId]));
  const byName = items.find((provider) => provider?.name && providerLabel.includes(provider.name) && connected.has(provider.id));
  if (byName?.id) return byName.id;
  const lpr = items.find((provider) => typeof provider?.id === "string" && provider.id.startsWith("lpr_") && connected.has(provider.id));
  if (lpr?.id) return lpr.id;
  const connectedMatch = items.find((provider) => connected.has(provider.id));
  return connectedMatch?.id ?? items[0]?.id ?? "";
}

async function readModelPickerOptions(ctx) {
  await expandModelPickerGroups(ctx);
  await ctx.waitFor(`(() => {
    const dialog = document.querySelector('[role="dialog"], [data-slot="dialog"]');
    return Boolean(dialog && [...dialog.querySelectorAll('button')].some((button) => button.textContent?.includes('gpt-5.')));
  })()`, { timeoutMs: 60_000, label: "model picker rows" });
  const rendered = await ctx.eval(`(() => {
    const dialog = document.querySelector('[role="dialog"], [data-slot="dialog"]');
    const groups = [];
    if (!dialog) return groups;
    const headers = [...dialog.querySelectorAll('button')]
      .filter((button) => /\\b\\d+ models?\\b/.test(button.textContent ?? ''));
    for (const header of headers) {
      const outer = header.parentElement?.parentElement;
      const rows = [...(outer?.querySelectorAll('div.ml-9 button') ?? [])];
      for (const row of rows) {
        const spans = [...row.querySelectorAll('span')].map((span) => (span.textContent ?? '').replace(/\\s+/g, ' ').trim()).filter(Boolean);
        const modelId = spans.at(-1) ?? '';
        const title = spans[0] ?? modelId;
        if (!modelId) continue;
        groups.push({ providerLabel: (header.textContent ?? '').replace(/\\s+/g, ' ').trim(), title, modelId });
      }
    }
    return groups;
  })()`);
  const providerList = await readEngineProviderList(ctx);
  return (Array.isArray(rendered) ? rendered : [])
    .map((row) => ({
      title: row.title,
      modelId: row.modelId,
      providerId: resolveRenderedProviderId(providerList, row.providerLabel, row.modelId),
      providerLabel: row.providerLabel,
    }))
    .sort((left, right) => `${left.providerId}:${left.modelId}`.localeCompare(`${right.providerId}:${right.modelId}`));
}

async function modelPickerDialogHasText(ctx, text) {
  return Boolean(await ctx.eval(`(() => {
    const dialog = document.querySelector('[role="dialog"], [data-slot="dialog"]');
    return Boolean(dialog && (dialog.innerText || '').includes(${JSON.stringify(text)}));
  })()`));
}

async function controlRaw(ctx, actionId, args = null) {
  return ctx.eval(`window.__openworkControl.execute(${JSON.stringify(actionId)}, ${JSON.stringify(args)})`, { awaitPromise: true });
}

async function closeModelPicker(ctx) {
  await ctx.eval(`(() => {
    const dialog = document.querySelector('[role="dialog"], [data-slot="dialog"]');
    if (!dialog) return true;
    const done = [...dialog.querySelectorAll('button')].find((button) => (button.textContent ?? '').trim() === 'Done');
    done?.click();
    return true;
  })()`);
  await sleep(300);
}

async function sampleReloadBanner(ctx) {
  await sleep(15_000);
  let positives = 0;
  const samples = [];
  for (let index = 0; index < 30; index += 1) {
    await sleep(2_000);
    const present = Boolean(await ctx.eval(`document.body.innerText.includes(${JSON.stringify(RELOAD_TEXT)})`));
    if (present) positives += 1;
    samples.push({ sample: index + 1, present });
  }
  return { positives, samples };
}

async function readRuntimeConfigHashes(ctx, workspaceId) {
  const entries = [];
  for (let index = 0; index < 5; index += 1) {
    const result = await openworkRequest(ctx, `/workspace/${encodeURIComponent(workspaceId)}/runtime-config`);
    ctx.assert(result.response.ok, `GET runtime-config sample ${index + 1} failed: ${result.response.status} ${safeBody(result.body)}`);
    entries.push({
      sample: index + 1,
      hash: createHash("sha256").update(result.text).digest("hex"),
      bytes: result.text.length,
    });
    if (index < 4) await sleep(5_000);
  }
  return entries;
}

async function readWorkspaceConfigState(ctx, workspaceId) {
  const config = await expectOpenworkJson(ctx, `/workspace/${encodeURIComponent(workspaceId)}/config`);
  const runtimeStatus = await expectOpenworkJson(ctx, `/workspace/${encodeURIComponent(workspaceId)}/runtime-config`);
  const providerList = await readEngineProviderList(ctx, workspaceId);
  const cloudProviders = config?.openwork?.cloudImports?.providers && typeof config.openwork.cloudImports.providers === "object"
    ? Object.keys(config.openwork.cloudImports.providers)
    : [];
  const runtimeConfig = runtimeStatus?.runtime && typeof runtimeStatus.runtime === "object"
    ? runtimeStatus.runtime
    : {};
  const runtimeProvider = runtimeConfig.provider && typeof runtimeConfig.provider === "object"
    ? runtimeConfig.provider
    : {};
  const disabledProviders = Array.isArray(runtimeConfig.disabled_providers)
    ? runtimeConfig.disabled_providers.filter((item) => typeof item === "string")
    : [];
  return {
    providers: cloudProviders.sort(),
    runtimeProviders: Object.keys(runtimeProvider).sort(),
    disabledProviders: disabledProviders.sort(),
    engineConnectedProviders: connectedProviderIds(providerList).sort(),
    engineAllProviders: providerItems(providerList).map((provider) => provider?.id).filter((id) => typeof id === "string").sort(),
  };
}

function lprKeys(values) {
  return values.filter((value) => typeof value === "string" && value.startsWith("lpr_")).sort();
}

async function listNotifications(ctx) {
  const result = await ctx.control("notifications.list");
  return Array.isArray(result) ? result : [];
}

function notificationLooksReloadRelated(entry) {
  const text = `${entry?.title ?? ""} ${entry?.body ?? ""} ${entry?.actionType ?? ""} ${entry?.actionLabel ?? ""}`.toLowerCase();
  return text.includes("reload") || text.includes("restart opencode") || text.includes("config changed");
}

function firstLine(value) {
  return String(value ?? "").split(/\r?\n/)[0]?.trim() ?? "";
}

function quietBootTable(frame) {
  const uniqueHashes = [...new Set(frame.runtimeHashes.map((entry) => entry.hash))];
  const rows = [
    ["Dialog history", `${frame.dialogs.length} dialog(s)`],
    ["engineReloads", String(frame.probe.counters.engineReloads)],
    ["configWrites", String(frame.probe.counters.configWrites)],
    ["runtimeConfigWrites", String(frame.probe.counters.runtimeConfigWrites)],
    ["cloudSyncCalls", String(frame.probe.counters.cloudSyncCalls)],
    ["pageReloadsAfterArming", String(frame.probe.pageReloadsAfterArming)],
    ["Reloading OpenCode config samples", `${frame.reloadBannerSamples.positives}/30`],
    ["runtime-config sha256 samples", frame.runtimeHashes.map((entry) => `${entry.sample}:${entry.hash.slice(0, 12)}(${entry.bytes}b)`).join(", ")],
    ["runtime-config unique hashes", String(uniqueHashes.length)],
    ["cloudImports.providers", frame.configState.providers.join(", ") || "none"],
    ["runtime opencode.provider", frame.configState.runtimeProviders.join(", ") || "none"],
    ["engine connected providers", frame.configState.engineConnectedProviders.join(", ") || "none"],
    ["runtime disabled_providers", frame.configState.disabledProviders.join(", ") || "none"],
    ["reload notifications", frame.reloadNotifications.length ? JSON.stringify(frame.reloadNotifications) : "none"],
  ];
  return ["| Metric | Observed |", "| --- | --- |", ...rows.map(([metric, observed]) => `| ${metric} | ${String(observed).replace(/\|/g, "\\|")} |`)].join("\n");
}

async function readDefaultModel(ctx) {
  return ctx.eval(`(() => {
    const raw = localStorage.getItem('openwork.defaultModel') || '';
    const [providerID, ...rest] = raw.split('/');
    return {
      raw,
      providerID: providerID || '',
      modelID: rest.join('/') || '',
    };
  })()`);
}

async function selectModel(ctx, modelId) {
  await openModelPicker(ctx);
  await expandModelPickerGroups(ctx);
  await ctx.waitFor(`(() => {
    const dialog = document.querySelector('[role="dialog"], [data-slot="dialog"]');
    if (!dialog) return false;
    const row = [...dialog.querySelectorAll('div.ml-9 button')]
      .find((button) => [...button.querySelectorAll('span')].some((span) => (span.textContent ?? '').trim() === ${JSON.stringify(modelId)}));
    row?.scrollIntoView({ block: 'center', inline: 'center' });
    row?.click();
    return Boolean(row);
  })()`, { timeoutMs: 30_000, label: `select model ${modelId}` });
  await closeModelPicker(ctx);
  await ctx.waitFor(`(localStorage.getItem('openwork.defaultModel') || '').endsWith('/' + ${JSON.stringify(modelId)})`, {
    timeoutMs: 10_000,
    label: `default model ${modelId}`,
  });
}
