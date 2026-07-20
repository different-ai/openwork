import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import {
  adminEnsureFreshAuth,
  denFetch,
  ensureRendererMounted,
  ensureWorkspaceReady,
  getPanelTargetId,
  memberRefresh,
  openAdminPanel,
  panelEval,
  sleep,
  waitForDesktopConfig,
  waitForPanel,
  waitUntil,
} from "./desktop-brand-icon.flow.mjs";

// Narration is loaded from the approved script (evals/voiceovers/org-custom-prompt-descriptions.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("org-custom-prompt-descriptions");

const DESKTOP_POLICIES_PATH = "/dashboard/desktop-policies";
const PROMPTS = [
  "Analyze the latest churn feedback and summarize the top three risks.",
  "Draft a launch-readiness brief for support, sales, and leadership.",
];
const DESCRIPTIONS = ["Review churn feedback", "Prepare launch brief"];

const state = {
  adminPanelTargetId: null,
  defaultPolicy: null,
  originalDefaultPolicy: null,
};

function denWebBase(ctx) {
  return ctx.env.OPENWORK_EVAL_DEN_WEB_URL.replace(/\/$/, "");
}

function desktopPoliciesUrl(ctx) {
  return `${denWebBase(ctx)}${DESKTOP_POLICIES_PATH}`;
}

function defaultPolicyEditorUrl(ctx) {
  if (!state.defaultPolicy?.id) throw new Error("Default desktop policy was not loaded.");
  return `${desktopPoliciesUrl(ctx)}/${encodeURIComponent(state.defaultPolicy.id)}`;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function arrayEquals(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function promptConfigEquals(value, prompts, descriptions) {
  const document = value?.policy ?? value ?? {};
  return arrayEquals(document.onboardingPrompts, prompts) && arrayEquals(document.onboardingPromptDescriptions, descriptions);
}

function originalPromptConfigEquals(policy, originalPolicy) {
  const current = policy?.policy ?? {};
  const original = originalPolicy?.policy ?? {};
  const currentPrompts = Array.isArray(current.onboardingPrompts) ? current.onboardingPrompts : null;
  const originalPrompts = Array.isArray(original.onboardingPrompts) ? original.onboardingPrompts : null;
  const currentDescriptions = Array.isArray(current.onboardingPromptDescriptions) ? current.onboardingPromptDescriptions : null;
  const originalDescriptions = Array.isArray(original.onboardingPromptDescriptions) ? original.onboardingPromptDescriptions : null;
  return JSON.stringify(currentPrompts) === JSON.stringify(originalPrompts) &&
    JSON.stringify(currentDescriptions) === JSON.stringify(originalDescriptions);
}

function policyPayloadFromSavedPolicy(policy) {
  const savedPolicy = policy.policy ?? {};
  const nextPolicy = { ...savedPolicy };
  if (Array.isArray(savedPolicy.onboardingPrompts)) {
    nextPolicy.onboardingPrompts = savedPolicy.onboardingPrompts;
    nextPolicy.onboardingPromptDescriptions = Array.isArray(savedPolicy.onboardingPromptDescriptions)
      ? savedPolicy.onboardingPromptDescriptions
      : null;
  } else {
    nextPolicy.onboardingPrompts = null;
    nextPolicy.onboardingPromptDescriptions = null;
  }
  return {
    policyName: policy.policyName,
    policy: nextPolicy,
    priority: policy.priority ?? 0,
    isEnabled: policy.isEnabled !== false,
    memberIds: (policy.assignments ?? []).flatMap((assignment) => assignment.orgMemberId ? [assignment.orgMemberId] : []),
    teamIds: (policy.assignments ?? []).flatMap((assignment) => assignment.teamId ? [assignment.teamId] : []),
  };
}

async function loadDefaultPolicy(ctx) {
  const { body } = await denFetch(ctx, "/v1/desktop-policies");
  const policies = Array.isArray(body?.desktopPolicies) ? body.desktopPolicies : [];
  const defaultPolicy = policies.find((policy) => policy?.isDefault === true);
  ctx.assert(defaultPolicy?.id, "The seeded Den org does not have a default desktop policy.");
  return defaultPolicy;
}

async function waitForDefaultPolicyPromptConfig(ctx, label, prompts, descriptions) {
  return waitUntil(ctx, label, async () => {
    const policy = await loadDefaultPolicy(ctx);
    return promptConfigEquals(policy, prompts, descriptions) ? policy : null;
  }, { timeoutMs: 30_000, intervalMs: 750 });
}

async function waitForDesktopPromptConfig(ctx, label, prompts, descriptions) {
  return waitForDesktopConfig(ctx, label, (config) => promptConfigEquals(config, prompts, descriptions), 30_000);
}

async function cleanupDefaultPolicy(ctx) {
  if (!state.originalDefaultPolicy?.id) {
    ctx.log("No original default desktop policy captured; skipping cleanup.");
    return null;
  }
  await denFetch(ctx, `/v1/desktop-policies/${state.originalDefaultPolicy.id}`, {
    method: "PATCH",
    body: JSON.stringify(policyPayloadFromSavedPolicy(state.originalDefaultPolicy)),
  });
  const restored = await waitUntil(ctx, "default desktop policy cleanup restore", async () => {
    const policy = await loadDefaultPolicy(ctx);
    return originalPromptConfigEquals(policy, state.originalDefaultPolicy) ? policy : null;
  }, { timeoutMs: 30_000, intervalMs: 750 });
  await memberRefresh(ctx).catch((error) => ctx.log(`Desktop refresh after cleanup failed: ${errorMessage(error)}`));
  return restored;
}

async function runWithErrorCleanup(ctx, callback) {
  try {
    return await callback();
  } catch (error) {
    await cleanupDefaultPolicy(ctx).catch((cleanupError) => {
      ctx.log(`Cleanup after failed frame also failed: ${errorMessage(cleanupError)}`);
    });
    throw error;
  }
}

async function ensureDesktopSession(ctx) {
  const { body } = await denFetch(ctx, "/v1/me/orgs");
  const organizations = Array.isArray(body?.orgs) ? body.orgs : [];
  const activeOrg = organizations.find((organization) => organization?.id === body?.activeOrgId) ?? organizations[0];
  ctx.assert(activeOrg?.id, "The eval token does not have an active organization.");

  await ctx.control("eval.auth.set-base-url", { baseUrl: ctx.env.OPENWORK_EVAL_DEN_WEB_URL });
  await ctx.eval(`(() => {
    localStorage.setItem('openwork.den.baseUrl', ${JSON.stringify(ctx.env.OPENWORK_EVAL_DEN_WEB_URL)});
    localStorage.setItem('openwork.den.apiBaseUrl', ${JSON.stringify(ctx.env.OPENWORK_EVAL_DEN_API_URL)});
    localStorage.setItem('openwork.den.authToken', ${JSON.stringify(ctx.env.OPENWORK_EVAL_DEN_TOKEN)});
    localStorage.setItem('openwork.den.activeOrgId', ${JSON.stringify(activeOrg.id)});
    localStorage.setItem('openwork.den.activeOrgSlug', ${JSON.stringify(activeOrg.slug ?? "example-corp")});
    localStorage.setItem('openwork.den.activeOrgName', ${JSON.stringify(activeOrg.name ?? "Example Corp")});
    window.dispatchEvent(new CustomEvent('openwork-den-settings-changed', { detail: {} }));
    window.dispatchEvent(new CustomEvent('openwork-den-session-updated', { detail: { token: ${JSON.stringify(ctx.env.OPENWORK_EVAL_DEN_TOKEN)} } }));
    return true;
  })()`);

  await waitUntil(ctx, "desktop Den session", async () => {
    const status = await ctx.control("auth.status", {}).catch(() => null);
    return status?.status === "signed_in" ? status : null;
  }, { timeoutMs: 30_000 });
}

async function dismissDesktopOverlays(ctx) {
  await ctx.eval(`(() => {
    const continueButton = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Continue without OpenWork Models')
    );
    if (continueButton) {
      continueButton.click();
      return 'continued-without-models';
    }
    const dialog = document.querySelector('[role="dialog"]');
    const closeButton = dialog?.querySelector('button[aria-label="Close"], button');
    if (closeButton) {
      closeButton.click();
      return 'closed-dialog';
    }
    return 'no-overlay';
  })()`);
  await sleep(300);
}

async function navigateAdminUrl(ctx, url, readyExpression, label) {
  await panelEval(ctx, `location.replace(${JSON.stringify(url)})`).catch(() => undefined);
  await sleep(500);
  try {
    await waitForPanel(ctx, readyExpression, { timeoutMs: 45_000, label });
  } catch {
    ctx.log(`${label} was not ready after first navigation; reloading once.`);
    await panelEval(ctx, "location.reload()").catch(() => undefined);
    await waitForPanel(ctx, readyExpression, { timeoutMs: 60_000, label: `${label} after reload` });
  }
}

async function waitForAdminSession(ctx) {
  return waitUntil(ctx, "Den admin browser session", async () => {
    const session = await panelEval(ctx, `fetch('/api/auth/get-session', { credentials: 'include' })
      .then((response) => response.ok ? response.json() : null)
      .catch(() => null)`, { awaitPromise: true });
    return session?.session?.userId ? session : null;
  }, { timeoutMs: 15_000, intervalMs: 250 });
}

async function navigateDefaultPolicyEditor(ctx) {
  await navigateAdminUrl(
    ctx,
    defaultPolicyEditorUrl(ctx),
    `document.body.innerText.includes('Edit desktop policy') && document.body.innerText.includes('Organization prompt suggestions')`,
    "default desktop policy editor",
  );
}

async function reloadDefaultPolicyEditor(ctx) {
  await navigateDefaultPolicyEditor(ctx);
  await panelEval(ctx, "location.reload()").catch(() => undefined);
  await waitForPanel(ctx, `document.body.innerText.includes('Edit desktop policy') && document.body.innerText.includes('Organization prompt suggestions')`, {
    timeoutMs: 60_000,
    label: "reloaded default desktop policy editor",
  });
}

async function ensurePromptEditorOpen(ctx) {
  await waitForPanel(ctx, `Boolean(Array.from(document.querySelectorAll('label')).find((label) =>
    label.textContent?.includes('Organization prompt suggestions')
  ))`, { timeoutMs: 20_000, label: "Organization prompt suggestions toggle" });
  await panelEval(ctx, `(() => {
    const label = Array.from(document.querySelectorAll('label')).find((entry) =>
      entry.textContent?.includes('Organization prompt suggestions')
    );
    const checkbox = label?.querySelector('input[type="checkbox"]');
    if (!checkbox) throw new Error('Organization prompt suggestions checkbox not found');
    if (!checkbox.checked) checkbox.click();
    label.scrollIntoView({ block: 'center' });
    return checkbox.checked;
  })()`);
  await waitForPanel(ctx, `document.querySelectorAll('input[placeholder="Card title shown in the desktop app"]').length === 3 && document.querySelectorAll('textarea').length === 3`, {
    timeoutMs: 15_000,
    label: "prompt and description fields",
  });
}

async function setPromptFieldValue(ctx, selector, index, value, label) {
  await panelEval(ctx, `(() => {
    const field = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))[${index}];
    if (!field) throw new Error(${JSON.stringify(`${label} field not found`)});
    const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (!setter) throw new Error('Native value setter not found');
    if (field._valueTracker) field._valueTracker.setValue(${JSON.stringify(value ? "" : "__previous_value__")});
    field.focus();
    setter.call(field, ${JSON.stringify(value)});
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    field.scrollIntoView({ block: 'center' });
    return field.value;
  })()`);
  await waitForPanel(ctx, `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))[${index}]?.value === ${JSON.stringify(value)}`, {
    timeoutMs: 5_000,
    label,
  });
}

async function setPromptFields(ctx) {
  await ensurePromptEditorOpen(ctx);
  const descriptionSelector = 'input[placeholder="Card title shown in the desktop app"]';
  const promptSelector = "textarea";
  for (const [index, value] of [...DESCRIPTIONS, ""].entries()) {
    await setPromptFieldValue(ctx, descriptionSelector, index, value, `description ${index + 1}`);
  }
  for (const [index, value] of [...PROMPTS, ""].entries()) {
    await setPromptFieldValue(ctx, promptSelector, index, value, `prompt ${index + 1}`);
  }
  await waitForAdminPromptValues(ctx, PROMPTS, DESCRIPTIONS);
}

async function readAdminPromptValues(ctx) {
  return panelEval(ctx, `(() => {
    const descriptions = Array.from(document.querySelectorAll('input[placeholder="Card title shown in the desktop app"]')).map((field) => field.value);
    const prompts = Array.from(document.querySelectorAll('textarea')).map((field) => field.value);
    const label = Array.from(document.querySelectorAll('label')).find((entry) => entry.textContent?.includes('Organization prompt suggestions'));
    const enabled = label?.querySelector('input[type="checkbox"]')?.checked === true;
    return { enabled, descriptions, prompts };
  })()`);
}

async function waitForAdminPromptValues(ctx, prompts, descriptions) {
  return waitUntil(ctx, "admin prompt input values", async () => {
    const values = await readAdminPromptValues(ctx);
    return values?.enabled && arrayEquals(values.prompts.slice(0, prompts.length), prompts) &&
      arrayEquals(values.descriptions.slice(0, descriptions.length), descriptions)
      ? values
      : null;
  }, { timeoutMs: 10_000, intervalMs: 250 });
}

async function scrollPromptCard(ctx, index) {
  await panelEval(ctx, `(() => {
    const prompts = Array.from(document.querySelectorAll('textarea'));
    const prompt = prompts[${index}];
    prompt?.closest('.grid')?.scrollIntoView({ block: 'center' });
    prompt?.focus();
    prompt?.setSelectionRange(prompt.value.length, prompt.value.length);
    return true;
  })()`).catch(() => undefined);
  await sleep(300);
}

async function clickSaveChanges(ctx) {
  await waitForPanel(ctx, `Boolean(Array.from(document.querySelectorAll('button')).find((button) =>
    button.textContent?.trim() === 'Save changes' && !button.disabled
  ))`, { timeoutMs: 15_000, label: "enabled Save changes button" });
  await panelEval(ctx, `(() => {
    const button = Array.from(document.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.trim() === 'Save changes' && !candidate.disabled
    );
    if (!button) throw new Error('Save changes button not found');
    button.scrollIntoView({ block: 'center' });
    button.click();
    return true;
  })()`);
}

async function waitForPoliciesList(ctx) {
  await waitForPanel(ctx, `document.body.innerText.includes('Desktop policies') && document.body.innerText.includes('Default desktop policy')`, {
    timeoutMs: 45_000,
    label: "desktop policies list after save",
  });
}

async function readPromptCardState(ctx) {
  return ctx.eval(`(() => {
    const cards = Array.from(document.querySelectorAll('button')).map((button) => {
      const spans = Array.from(button.querySelectorAll('span')).map((span) => (span.textContent ?? '').trim()).filter(Boolean);
      return { title: spans[0] ?? '', description: spans[1] ?? '', text: (button.textContent ?? '').trim() };
    });
    const card = cards.find((entry) => entry.title === ${JSON.stringify(DESCRIPTIONS[0])} && entry.description === ${JSON.stringify(PROMPTS[0])}) ?? null;
    return { card, cards };
  })()`);
}

async function waitForPromptCard(ctx) {
  return waitUntil(ctx, "desktop organization prompt card", async () => {
    const stateValue = await readPromptCardState(ctx);
    return stateValue?.card ? stateValue : null;
  }, { timeoutMs: 60_000, intervalMs: 500 });
}

async function openFreshDesktopSession(ctx) {
  await ensureWorkspaceReady(ctx);
  await ctx.waitFor(
    "window.__openworkControl.listActions().some((action) => action.id === 'session.create_task' && !action.disabled)",
    { timeoutMs: 60_000, label: "new session action" },
  );
  await ctx.control("session.create_task");
  await ctx.waitFor(
    "Boolean(document.querySelector('[contenteditable=\"true\"][data-lexical-editor=\"true\"]') || document.querySelector('[contenteditable=\"true\"]'))",
    { timeoutMs: 30_000, label: "new-session composer" },
  );
}

async function markPromptCardForClick(ctx) {
  return ctx.eval(`(() => {
    for (const button of Array.from(document.querySelectorAll('button'))) {
      const spans = Array.from(button.querySelectorAll('span')).map((span) => (span.textContent ?? '').trim()).filter(Boolean);
      if (spans[0] === ${JSON.stringify(DESCRIPTIONS[0])} && spans[1] === ${JSON.stringify(PROMPTS[0])}) {
        button.setAttribute('data-eval-org-prompt-card', 'true');
        button.scrollIntoView({ block: 'center', inline: 'center' });
        return { title: spans[0], description: spans[1] };
      }
    }
    return null;
  })()`);
}

async function readComposerState(ctx) {
  return ctx.eval(`(() => {
    const composer = window.__openwork?.slice?.('composer');
    const editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]') || document.querySelector('[contenteditable="true"]');
    return {
      draft: composer?.draft ?? null,
      draftLength: composer?.draftLength ?? null,
      editorText: editor?.innerText ?? '',
    };
  })()`);
}

export default {
  id: "org-custom-prompt-descriptions",
  title: "Organization prompt descriptions persist and become desktop suggestion card titles",
  kind: "user-facing",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_TOKEN", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "setup",
      run: async (ctx) => {
        await ensureRendererMounted(ctx);
        await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 30_000, label: "window.__openworkControl" });
        await ctx.ensureLightMode();
        await ensureDesktopSession(ctx);
        await ensureWorkspaceReady(ctx);
        await dismissDesktopOverlays(ctx);
        state.defaultPolicy = cloneJson(await loadDefaultPolicy(ctx));
        state.originalDefaultPolicy = cloneJson(state.defaultPolicy);
        await openAdminPanel(ctx);
        await adminEnsureFreshAuth(ctx);
        await waitForAdminSession(ctx);
        await navigateDefaultPolicyEditor(ctx);
        state.adminPanelTargetId = await getPanelTargetId(ctx);
        ctx.log(`Captured original default desktop policy ${state.defaultPolicy.id}.`);
      },
    },
    {
      name: "Frame 1",
      run: async (ctx) => {
        await runWithErrorCleanup(ctx, async () => {
          await ctx.prove("Admin enters prompt descriptions beside prompt fields in the default desktop policy", {
            voiceover: vo[0],
            action: async () => {
              await navigateDefaultPolicyEditor(ctx);
              state.adminPanelTargetId = await getPanelTargetId(ctx);
              await setPromptFields(ctx);
              await scrollPromptCard(ctx, 0);
            },
            assert: async () => {
              const values = await readAdminPromptValues(ctx);
              ctx.assert(values?.enabled === true, "Organization prompt suggestions were not enabled in the admin editor.");
              ctx.assert(arrayEquals(values.prompts.slice(0, PROMPTS.length), PROMPTS), `Prompt inputs did not contain the seeded prompts: ${JSON.stringify(values)}`);
              ctx.assert(arrayEquals(values.descriptions.slice(0, DESCRIPTIONS.length), DESCRIPTIONS), `Description inputs did not contain the seeded descriptions: ${JSON.stringify(values)}`);
              ctx.recordEvidence({ type: "assertion", status: "passed", assertion: "Admin editor input values include two prompts and their descriptions", actual: values });
            },
            screenshot: {
              name: "frame-1-admin-description-inputs",
              sandboxCapture: true,
              targetId: state.adminPanelTargetId,
              textTargetId: state.adminPanelTargetId,
              requireText: ["Edit desktop policy", "Organization prompt suggestions", "Description", "Prompt", "Save changes"],
              rejectText: ["Something went wrong", "Failed to load", "Description must be"],
            },
          });
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await runWithErrorCleanup(ctx, async () => {
          await ctx.prove("Saving and reloading preserves prompt descriptions in Den and in the editor", {
            voiceover: vo[1],
            action: async () => {
              await waitForAdminPromptValues(ctx, PROMPTS, DESCRIPTIONS);
              await clickSaveChanges(ctx);
              await waitForPoliciesList(ctx);
              state.defaultPolicy = cloneJson(await waitForDefaultPolicyPromptConfig(ctx, "Den default policy prompt descriptions", PROMPTS, DESCRIPTIONS));
              await waitForDesktopPromptConfig(ctx, "effective desktop config prompt descriptions", PROMPTS, DESCRIPTIONS);
              await reloadDefaultPolicyEditor(ctx);
              await waitForAdminPromptValues(ctx, PROMPTS, DESCRIPTIONS);
              await scrollPromptCard(ctx, 1);
            },
            assert: async () => {
              const policy = await loadDefaultPolicy(ctx);
              const config = await waitForDesktopPromptConfig(ctx, "effective desktop config still has prompt descriptions", PROMPTS, DESCRIPTIONS);
              const values = await readAdminPromptValues(ctx);
              ctx.assert(promptConfigEquals(policy, PROMPTS, DESCRIPTIONS), `Desktop policy API did not persist prompt descriptions: ${JSON.stringify(policy?.policy)}`);
              ctx.assert(promptConfigEquals(config, PROMPTS, DESCRIPTIONS), `Desktop config API did not expose prompt descriptions: ${JSON.stringify(config)}`);
              ctx.assert(arrayEquals(values.prompts.slice(0, PROMPTS.length), PROMPTS), `Reloaded prompt fields did not keep values: ${JSON.stringify(values)}`);
              ctx.assert(arrayEquals(values.descriptions.slice(0, DESCRIPTIONS.length), DESCRIPTIONS), `Reloaded description fields did not keep values: ${JSON.stringify(values)}`);
              ctx.recordEvidence({ type: "assertion", status: "passed", assertion: "Den API and the reloaded admin form preserve prompts and descriptions", actual: { policy: policy.policy, config, values } });
            },
            screenshot: {
              name: "frame-2-admin-reloaded-values",
              sandboxCapture: true,
              targetId: state.adminPanelTargetId,
              textTargetId: state.adminPanelTargetId,
              requireText: ["Edit desktop policy", "Organization prompt suggestions", "Second prompt", "Description", "Save changes"],
              rejectText: ["Something went wrong", "Failed to load", "Description must be"],
            },
          });
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await runWithErrorCleanup(ctx, async () => {
          await ctx.prove("The desktop new-session screen renders the saved description as the organization prompt card title", {
            voiceover: vo[2],
            action: async () => {
              const config = await waitForDesktopPromptConfig(ctx, "member effective prompt descriptions before opening session", PROMPTS, DESCRIPTIONS);
              await ctx.eval(`(() => {
                const applyDesktopConfig = window.__openworkApplyDesktopConfig;
                if (typeof applyDesktopConfig !== 'function') throw new Error('Desktop config eval bridge is unavailable');
                applyDesktopConfig(${JSON.stringify(config)});
                return true;
              })()`);
              await openFreshDesktopSession(ctx);
              await waitForPromptCard(ctx);
            },
            assert: async () => {
              const cardState = await readPromptCardState(ctx);
              ctx.assert(cardState?.card?.title === DESCRIPTIONS[0], `Desktop card title did not use the saved description: ${JSON.stringify(cardState)}`);
              ctx.assert(cardState?.card?.description === PROMPTS[0], `Desktop card description did not contain the full prompt: ${JSON.stringify(cardState)}`);
              ctx.recordEvidence({ type: "assertion", status: "passed", assertion: "Desktop suggestion card title is the saved Description and its body is the full Prompt", actual: cardState.card });
            },
            screenshot: {
              name: "frame-3-desktop-description-card",
              requireText: [DESCRIPTIONS[0], PROMPTS[0]],
              rejectText: ["Organization prompt 1", "Something went wrong"],
            },
          });
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await runWithErrorCleanup(ctx, async () => {
          await ctx.prove("Clicking the description-titled card inserts the full custom prompt into the composer", {
            voiceover: vo[3],
            action: async () => {
              const marked = await markPromptCardForClick(ctx);
              ctx.assert(marked?.title === DESCRIPTIONS[0], `Could not mark the organization prompt card for click: ${JSON.stringify(marked)}`);
              await ctx.trustedClick('[data-eval-org-prompt-card="true"]', { timeoutMs: 10_000 });
              await ctx.waitFor(
                `window.__openwork?.slice?.('composer')?.draft === ${JSON.stringify(PROMPTS[0])}`,
                { timeoutMs: 10_000, label: "composer draft after organization prompt card click" },
              );
            },
            assert: async () => {
              const composer = await readComposerState(ctx);
              ctx.assert(composer?.draft === PROMPTS[0], `Composer draft did not equal the full prompt after card click: ${JSON.stringify(composer)}`);
              ctx.assert(composer?.editorText?.includes(PROMPTS[0]), `Composer DOM did not render the full prompt after card click: ${JSON.stringify(composer)}`);
              ctx.recordEvidence({ type: "assertion", status: "passed", assertion: "A trusted card click placed the full prompt into the composer", actual: composer });
            },
            screenshot: {
              name: "frame-4-composer-full-prompt",
              requireText: [PROMPTS[0]],
              rejectText: ["Organization prompt 1", "Something went wrong"],
            },
          });
        });
      },
    },
    {
      name: "cleanup",
      run: async (ctx) => {
        const restored = await cleanupDefaultPolicy(ctx);
        ctx.recordEvidence({ type: "assertion", status: "passed", assertion: "Non-narrated cleanup restored the original default desktop policy prompt configuration", actual: restored?.policy ?? null });
      },
    },
  ],
};
