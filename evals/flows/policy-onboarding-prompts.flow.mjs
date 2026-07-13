import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const vo = await loadVoiceoverParagraphs("policy-onboarding-prompts");
const DEN_API_URL = (process.env.OPENWORK_EVAL_DEN_API_URL ?? "").trim().replace(/\/+$/, "");
const DEN_WEB_URL = (process.env.OPENWORK_EVAL_DEN_WEB_URL ?? "http://localhost:3005").trim().replace(/\/+$/, "");
const DESKTOP_URL = (process.env.OPENWORK_EVAL_DESKTOP_URL ?? "http://localhost:5173").trim().replace(/\/+$/, "");
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const POLICY_NAME = "Product onboarding prompts";
const ORG_PROMPTS = [
  "Summarize the latest customer feedback and identify the top three product opportunities.",
  "Draft a weekly product update for engineering, design, and leadership.",
  "Turn these meeting notes into owners, decisions, and next steps.",
];
const state = { desktopUrl: null, token: null };

async function apiRequest(path, options = {}) {
  const response = await fetch(`${DEN_API_URL}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${state.token}`,
      "content-type": "application/json",
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
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${path} returned ${response.status}: ${text}`);
  }
  return body;
}

async function resetDemoPolicy() {
  const list = await apiRequest("/v1/desktop-policies");
  const previous = list.desktopPolicies.filter((policy) => !policy.isDefault && policy.policyName === POLICY_NAME);
  for (const policy of previous) {
    await apiRequest(`/v1/desktop-policies/${policy.id}`, { method: "DELETE" });
  }
}

async function openEmptyDesktopSession(ctx, config = {}) {
  await ctx.eval(`location.assign(${JSON.stringify(state.desktopUrl)})`);
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "desktop control API" });
  await ctx.waitFor(
    "window.__openworkControl.listActions().some((action) => action.id === 'session.create_task' && !action.disabled)",
    { timeoutMs: 60_000, label: "new session action" },
  );
  await ctx.eval(`(() => {
    localStorage.setItem('openwork.react.settings.theme-mode', 'light');
    const apply = window.__openworkApplyDesktopConfig;
    if (typeof apply === 'function') apply(${JSON.stringify(config)});
    return true;
  })()`);
  await ctx.control("session.create_task");
  await ctx.waitFor("document.body.innerText.includes('Try one of')", { timeoutMs: 30_000, label: "empty-session suggestions" });
}

async function enterDenPolicies(ctx) {
  await ctx.eval(`location.assign(${JSON.stringify(DEN_WEB_URL)})`);
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 60_000, label: "Den web" });
  const signIn = await ctx.eval(`fetch('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email: ${JSON.stringify(ADMIN_EMAIL)}, password: ${JSON.stringify(ADMIN_PASSWORD)} }),
  }).then(async (response) => ({ status: response.status, body: await response.text() }))`, { awaitPromise: true });
  ctx.assert(signIn.status === 200, `Den browser sign-in failed: ${signIn.status} ${signIn.body}`);
  await ctx.eval(`location.assign(${JSON.stringify(`${DEN_WEB_URL}/dashboard/desktop-policies`)})`);
  await ctx.waitFor("document.body.innerText.includes('Desktop policies') && document.body.innerText.includes('New policy')", {
    timeoutMs: 60_000,
    label: "desktop policies page",
  });
}

export default {
  id: "policy-onboarding-prompts",
  title: "Desktop policies replace OpenWork starter suggestions for assigned teams",
  kind: "user-facing",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_TOKEN"],
  steps: [
    {
      name: "Setup",
      run: async (ctx) => {
        state.desktopUrl = DESKTOP_URL;
        state.token = ctx.env.OPENWORK_EVAL_DEN_TOKEN;
        await resetDemoPolicy();
        await openEmptyDesktopSession(ctx);
      },
    },
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("OpenWork supplies useful local suggestions without organization configuration", {
          voiceover: vo[0],
          action: async () => {
            await ctx.waitForText("Try one of these:", { timeoutMs: 30_000 });
          },
          assert: async () => {
            await ctx.expectText("Edit a CSV");
            await ctx.expectText("Browse the web");
            await ctx.expectText("Connect an extension");
            await ctx.expectNoText("Organization prompt 1");
          },
          screenshot: {
            name: "openwork-default-suggestions",
            requireText: ["Try one of these:", "Edit a CSV", "Browse the web", "Connect an extension"],
            rejectText: ["Something went wrong", "Organization prompt 1"],
          },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("A Den admin creates onboarding configuration inside Desktop Policies", {
          voiceover: vo[1],
          action: async () => {
            await enterDenPolicies(ctx);
            await ctx.clickText("New policy");
            await ctx.waitForText("New desktop policy", { timeoutMs: 30_000 });
            await ctx.eval(`(() => {
              const label = [...document.querySelectorAll('label')].find((entry) => entry.textContent.includes('Organization prompt suggestions'));
              label?.scrollIntoView({ block: 'center' });
              return Boolean(label);
            })()`);
          },
          assert: async () => {
            await ctx.expectText("Priority");
            await ctx.expectText("Organization prompt suggestions");
            await ctx.expectText("Members");
            await ctx.expectText("Teams");
          },
          screenshot: {
            name: "den-new-desktop-policy",
            requireText: ["New desktop policy", "Priority", "Organization prompt suggestions"],
            rejectText: ["Something went wrong", "Failed to load"],
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("The policy accepts two or three organization-provided prompts", {
          voiceover: vo[2],
          action: async () => {
            await ctx.fill('input:not([type="checkbox"]):not([type="number"])', POLICY_NAME);
            await ctx.fill('input[type="number"]', "1000000");
            await ctx.eval(`(() => {
              const label = [...document.querySelectorAll('label')].find((entry) => entry.textContent.includes('Organization prompt suggestions'));
              const checkbox = label?.querySelector('input[type="checkbox"]');
              checkbox?.click();
              return Boolean(checkbox);
            })()`);
            await ctx.waitFor("document.querySelectorAll('textarea').length === 3", { timeoutMs: 10_000, label: "prompt fields" });
            for (const [index, prompt] of ORG_PROMPTS.entries()) {
              await ctx.eval(`(() => {
                const field = [...document.querySelectorAll('textarea')][${index}];
                if (!field) return false;
                const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
                setter?.call(field, ${JSON.stringify(prompt)});
                field.dispatchEvent(new Event('input', { bubbles: true }));
                return true;
              })()`);
              await ctx.waitFor(`document.querySelectorAll('textarea')[${index}]?.value === ${JSON.stringify(prompt)}`, {
                timeoutMs: 5_000,
                label: `organization prompt ${index + 1}`,
              });
            }
            await ctx.eval("document.querySelector('textarea')?.scrollIntoView({ block: 'center' })");
          },
          assert: async () => {
            const values = await ctx.eval("[...document.querySelectorAll('textarea')].map((field) => field.value)");
            ctx.assert(JSON.stringify(values) === JSON.stringify(ORG_PROMPTS), `Prompt fields did not retain their values: ${JSON.stringify(values)}`);
          },
          screenshot: {
            name: "den-onboarding-prompts",
            requireText: ["Organization prompt suggestions", "First prompt", "Second prompt", "Optional third prompt"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("The existing assignment controls scope the onboarding prompts to a member", {
          voiceover: vo[3],
          action: async () => {
            await ctx.eval(`(() => {
              const label = [...document.querySelectorAll('label')].find((entry) => entry.textContent.trim() === 'Alex Chen');
              const checkbox = label?.querySelector('input[type="checkbox"]');
              if (checkbox && !checkbox.checked) checkbox.click();
              label?.scrollIntoView({ block: 'center' });
              return Boolean(checkbox);
            })()`);
          },
          assert: async () => {
            const checked = await ctx.eval(`(() => {
              const label = [...document.querySelectorAll('label')].find((entry) => entry.textContent.trim() === 'Alex Chen');
              return label?.querySelector('input[type="checkbox"]')?.checked === true;
            })()`);
            ctx.assert(checked, "Alex Chen was not assigned to the policy.");
          },
          screenshot: {
            name: "den-member-assignment",
            requireText: ["Members", "Teams", "Alex Chen"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await ctx.prove("Assigned members see organization prompts while OpenWork remains the fallback", {
          voiceover: vo[4],
          action: async () => {
            await ctx.clickText("Create policy");
            await ctx.waitForText(POLICY_NAME, { timeoutMs: 30_000 });
            const config = await apiRequest("/v1/me/desktop-config");
            ctx.assert(JSON.stringify(config.onboardingPrompts) === JSON.stringify(ORG_PROMPTS), `Effective config did not select the assigned policy: ${JSON.stringify(config)}`);
            await openEmptyDesktopSession(ctx, config);
          },
          assert: async () => {
            await ctx.expectText("Try one of your organization's prompts:");
            await ctx.expectText("Organization prompt 1");
            await ctx.expectText(ORG_PROMPTS[0]);
            await ctx.expectNoText("Edit a CSV");
            const config = await apiRequest("/v1/me/desktop-config");
            ctx.assert(config.onboardingPrompts?.length === 3, "The effective desktop config did not contain three organization prompts.");
          },
          screenshot: {
            name: "desktop-organization-prompts",
            requireText: ["Try one of your organization's prompts:", "Organization prompt 1", ORG_PROMPTS[0]],
            rejectText: ["Edit a CSV", "Something went wrong"],
          },
        });
      },
    },
  ],
};
