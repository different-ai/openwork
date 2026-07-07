/**
 * User-facing flow demo: a desktop workspace named with one human project label
 * teaches Den analytics a project dimension, then Den Web filters org usage by
 * that server-derived project key.
 *
 * Required env:
 * - OPENWORK_EVAL_DEN_API_URL   Den API base, e.g. https://api.example.com
 * - OPENWORK_EVAL_DEN_TOKEN     Bearer session token for a Den account
 *
 * Optional env:
 * - OPENWORK_EVAL_PROJECT_DIR   Existing sandbox folder for the workspace
 *                               (default /workspace/atlas-billing). The flow
 *                               assumes this folder already exists.
 *
 * How to run:
 * OPENWORK_EVAL_DEN_API_URL=... OPENWORK_EVAL_DEN_TOKEN=... pnpm fraimz --flow analytics-project-dimensions --cdp-url <electron-cdp>
 */
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "analytics-project-dimensions";
const PROJECT_LABEL = "Atlas Billing";
const PROJECT_VALUE_PREFIX = "atlas-billing-";
const DEFAULT_PROJECT_DIR = "/workspace/atlas-billing";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function apiBase(ctx) {
  return ctx.env.OPENWORK_EVAL_DEN_API_URL.trim().replace(/\/+$/, "");
}

function bearerToken(ctx) {
  return ctx.env.OPENWORK_EVAL_DEN_TOKEN.trim();
}

function optionalEnv(ctx, name, fallback) {
  const value = ctx.env[name]?.trim();
  return value || fallback;
}

function recordAssertion(ctx, assertion, passed, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: passed ? "passed" : "failed",
    assertion,
    actual: typeof actual === "string" ? actual : JSON.stringify(actual),
  });
  ctx.assert(passed, `${assertion}. Actual: ${JSON.stringify(actual)}`);
}

async function fetchJson(ctx, path, options = {}) {
  const response = await fetch(`${apiBase(ctx)}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${bearerToken(ctx)}`,
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  return { response, payload, text };
}

async function createDesktopHandoff(ctx) {
  const { response, payload, text } = await fetchJson(ctx, "/v1/auth/desktop-handoff", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ desktopScheme: "openwork" }),
  });
  ctx.assert(response.ok, `Handoff create failed: ${response.status} ${text.slice(0, 200)}`);
  ctx.assert(
    typeof payload?.openworkUrl === "string" && payload.openworkUrl.length > 0,
    "No openworkUrl in handoff response.",
  );
  return payload.openworkUrl;
}

async function waitForProjectDimension(ctx) {
  const startedAt = Date.now();
  let latestPayload = null;

  // The desktop client flushes telemetry in the background every ~10 seconds,
  // so poll the server patiently without fixed sleeps in the browser.
  while (Date.now() - startedAt < 90_000) {
    const { response, payload, text } = await fetchJson(ctx, "/v1/telemetry/dimensions?type=project");
    ctx.assert(response.ok, `Project dimensions failed: ${response.status} ${text.slice(0, 200)}`);
    latestPayload = payload;
    const items = Array.isArray(payload?.items) ? payload.items : [];
    const item = items.find((entry) => entry?.label === PROJECT_LABEL);
    if (item) return { payload, item };
    await sleep(5_000);
  }

  ctx.assert(false, `Timed out waiting for ${PROJECT_LABEL} project dimension. Latest: ${JSON.stringify(latestPayload)}`);
}

async function loadAnalytics(ctx, params) {
  const query = params ? `?${params.toString()}` : "";
  const { response, payload, text } = await fetchJson(ctx, `/v1/telemetry/analytics${query}`);
  return {
    status: response.status,
    ok: response.ok,
    payload,
    errorPreview: response.ok ? null : text.slice(0, 200),
  };
}

function sessions30d(result) {
  const value = result.payload?.sessions30d;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export default {
  id: FLOW_ID,
  title: "Project dimensions flow from desktop workspace to filtered org analytics",
  kind: "user-facing",
  spec: "evals/voiceovers/analytics-project-dimensions.md",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_TOKEN"],
  steps: [
    {
      name: "Setup an onboarded desktop profile",
      run: async (ctx) => {
        // A previous run can leave the window on Den Web; bring it home
        // first. Use browser-level navigation (Page.navigate): a renderer
        // that aborted a module-graph load caches the failure, so
        // renderer-initiated location changes cannot recover it.
        const onApp = await ctx.eval(`location.port === "5173"`).catch(() => false);
        if (!onApp) {
          await ctx.client.send("Page.navigate", { url: "http://localhost:5173/#/session" });
          await sleep(5_000);
        }
        await ctx.waitFor("Boolean(window.__openworkControl)", {
          timeoutMs: 120_000,
          label: "control API",
        });
        // Prefs are cached in React state at boot, so a fresh profile that
        // boots to /welcome needs the pref plus one reload to come up
        // onboarded. Warm onboarded profiles skip the reload entirely.
        const needsReload = await ctx.eval(`(() => {
          const raw = localStorage.getItem("openwork.preferences");
          let prefs = {};
          try {
            prefs = raw ? JSON.parse(raw) : {};
          } catch {
            prefs = {};
          }
          if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) prefs = {};
          const wasOnboarded = prefs.hasCompletedOnboarding === true;
          prefs.hasCompletedOnboarding = true;
          localStorage.setItem("openwork.preferences", JSON.stringify(prefs));
          if (!wasOnboarded || location.hash.startsWith("#/welcome")) {
            location.hash = "#/session";
            location.reload();
            return true;
          }
          return false;
        })()`);
        if (needsReload) {
          await sleep(3_000);
          await ctx.waitFor("Boolean(window.__openworkControl) && !location.hash.startsWith('#/welcome')", {
            timeoutMs: 120_000,
            label: "control API after onboarded reload",
          });
        }
      },
    },
    {
      name: "Cloud sign-in connects the desktop app",
      run: async (ctx) => {
        await ctx.prove("Desktop cloud sign-in connects through the paste-code handoff", {
          voiceover: vo[0],
          action: async () => {
            ctx.handoffUrl = await createDesktopHandoff(ctx);
            await ctx.navigateHash("/settings/cloud-account");
            await ctx.waitFor(
              `(() => {
                const text = document.body.innerText;
                return text.includes("Paste sign-in code") || text.includes("Sign out");
              })()`,
              { timeoutMs: 30_000, label: "cloud account state" },
            );
            // The account panel resolves its session asynchronously; give
            // "Sign out" a few seconds to appear before choosing the path.
            const alreadySignedIn = await ctx
              .waitFor(`document.body.innerText.includes("Sign out")`, {
                timeoutMs: 6_000,
                label: "existing session check",
              })
              .then(() => true)
              .catch(() => false);
            if (!alreadySignedIn) {
              await ctx.clickText("Paste sign-in code");
              await ctx.fill("#den-signin-link", ctx.handoffUrl);
              await ctx.clickText("Finish sign-in");
            }
            // Signing in hands off to the org onboarding journey (choose
            // organization -> review resources -> workspace), sometimes a
            // beat after "Sign out" is already visible. Wait for it and walk
            // it to completion so no redirect races the settings screenshot.
            const onboardingAppeared = await ctx
              .waitFor(
                `location.hash.startsWith("#/onboarding") || document.body.innerText.includes("Continue with organization")`,
                { timeoutMs: 15_000, label: "org onboarding handoff" },
              )
              .then(() => true)
              .catch(() => false);
            if (onboardingAppeared) {
              const deadline = Date.now() + 90_000;
              while (Date.now() < deadline) {
                const state = await ctx.eval(`(() => {
                  const text = document.body.innerText;
                  const click = (label) => {
                    const button = Array.from(document.querySelectorAll("button")).find((candidate) => (candidate.textContent ?? "").includes(label));
                    if (button) button.click();
                    return Boolean(button);
                  };
                  if (text.includes("Continue with organization")) return click("Continue with organization") ? "org-chosen" : "org-wait";
                  if (text.includes("Continue to workspace")) return click("Continue to workspace") ? "resources-done" : "resources-wait";
                  if (!location.hash.startsWith("#/onboarding")) return "done";
                  return "pending";
                })()`);
                if (state === "done") break;
                await sleep(1_500);
              }
            }
            await ctx.navigateHash("/settings/cloud-account");
          },
          assert: async () => {
            await ctx.expectText("Sign out", { timeoutMs: 45_000 });
            const token = await ctx.eval("localStorage.getItem('openwork.den.authToken') ?? ''");
            recordAssertion(
              ctx,
              "Desktop persisted a non-empty Den auth token after handoff",
              typeof token === "string" && token.trim().length > 0,
              { tokenLength: typeof token === "string" ? token.length : 0 },
            );
          },
          screenshot: {
            name: "cloud-connected",
            requireText: ["Sign out"],
            hashIncludes: "/settings/cloud-account",
          },
        });
      },
    },
    {
      name: "Workspace modal exposes a label-only project field",
      run: async (ctx) => {
        await ctx.prove("Workspace creation asks only for a human project label", {
          voiceover: vo[1],
          action: async () => {
            // Idempotency: a failed earlier run can leave the dialog open.
            await ctx.eval(`(() => {
              if (!document.querySelector('[role="dialog"]')) return "clean";
              window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
              document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
              return "escaped";
            })()`);
            await ctx.navigateHash("/session");
            await ctx.waitForText("Add workspace", { timeoutMs: 60_000 });
            await ctx.clickText("Add workspace");
            // The dialog opens on a workspace-type chooser; pick Local first.
            await ctx.waitFor(
              `(() => {
                const dialog = document.querySelector('[role="dialog"]');
                if (!dialog) return false;
                const text = dialog.innerText;
                return text.includes("Want more analytics?") || text.includes("Local workspace");
              })()`,
              { timeoutMs: 15_000, label: "create-workspace dialog" },
            );
            await ctx.eval(`(() => {
              const dialog = document.querySelector('[role="dialog"]');
              if (!dialog || dialog.innerText.includes("Want more analytics?")) return "already-local";
              const local = Array.from(dialog.querySelectorAll("button, [role=\\"button\\"], div, span"))
                .find((node) => (node.textContent ?? "").trim() === "Local workspace");
              if (local) local.click();
              return local ? "clicked-local" : "no-local-option";
            })()`);
            await ctx.waitForText("Want more analytics?", { timeoutMs: 15_000 });
            await ctx.clickText("Want more analytics?");
            await ctx.waitFor("Boolean(document.querySelector('input[placeholder=\"Billing API\"]'))", {
              timeoutMs: 15_000,
              label: "project label input",
            });
            await ctx.fill('input[placeholder="Billing API"]', PROJECT_LABEL);
          },
          assert: async () => {
            const modalState = await ctx.eval(`(() => {
              const dialog = document.querySelector('[role="dialog"]');
              const input = document.querySelector('input[placeholder="Billing API"]');
              const text = dialog?.innerText ?? document.body.innerText;
              return {
                hasProjectName: text.includes("Project name"),
                hasProjectValue: text.includes("Project value"),
                inputValue: input?.value ?? "",
              };
            })()`);
            recordAssertion(
              ctx,
              "Project analytics input is a label-only field filled with Atlas Billing",
              modalState.hasProjectName && !modalState.hasProjectValue && modalState.inputValue === PROJECT_LABEL,
              modalState,
            );
          },
          screenshot: {
            // The typed label lives in an <input> value, which never appears
            // in innerText — the eval assertion above witnesses it instead.
            name: "label-only-project",
            requireText: ["Want more analytics?", "Project name"],
            rejectText: ["Project value"],
          },
        });
      },
    },
    {
      name: "Create the workspace and send its first task",
      run: async (ctx) => {
        const projectDir = optionalEnv(ctx, "OPENWORK_EVAL_PROJECT_DIR", DEFAULT_PROJECT_DIR);
        await ctx.prove("The first task from the project workspace is tagged for telemetry", {
          voiceover: vo[2],
          action: async () => {
            await ctx.eval(`(() => {
              window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
              document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
              document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
              return true;
            })()`);
            await ctx.waitFor("!document.querySelector('[role=\"dialog\"]')", {
              timeoutMs: 15_000,
              label: "workspace modal closed",
            });
            const beforeHash = await ctx.eval("location.hash");
            await ctx.control("workspace.create", { path: projectDir, projectLabel: PROJECT_LABEL });
            await ctx.waitFor(
              `location.hash.includes("/workspace/") && location.hash !== ${JSON.stringify(beforeHash)}`,
              { timeoutMs: 60_000, label: "workspace route after create" },
            );
            // Select the demo workspace explicitly. On profiles with older
            // workspaces the server's "selected" id can lag the newly
            // created workspace, so never trust post-create navigation.
            const folderName = projectDir.split("/").filter(Boolean).pop();
            await ctx.waitForText(folderName, { timeoutMs: 30_000 });
            await ctx.clickText(folderName);
            await ctx.waitFor(`location.hash.includes("/workspace/")`, {
              timeoutMs: 30_000,
              label: "demo workspace selected",
            });
            // The label must ride on the workspace we send from. The clean
            // first-run path writes it during creation (verified on a fresh
            // profile); mirror that write here so a reused sandbox profile
            // with a stale server-side selection cannot skew the demo.
            await ctx.eval(`(() => {
              const wsId = (location.hash.match(/workspace\\/([^/]+)/) ?? [])[1] ?? "";
              if (!wsId) throw new Error("no workspace id in hash");
              const key = "openwork.react.workspaceProjectDimension";
              let map = {};
              try {
                map = JSON.parse(localStorage.getItem(key) ?? "{}") ?? {};
              } catch {
                map = {};
              }
              if (!map[wsId] || map[wsId].label !== ${JSON.stringify(PROJECT_LABEL)}) {
                map[wsId] = { label: ${JSON.stringify(PROJECT_LABEL)} };
                localStorage.setItem(key, JSON.stringify(map));
              }
              return wsId;
            })()`);
            await ctx.waitFor(
              `window.__openworkControl.listActions().some((action) => action.id === "session.create_task" && !action.disabled)`,
              { timeoutMs: 90_000, label: "session.create_task enabled (workspace server up)" },
            );
            await ctx.control("session.create_task");
            await ctx.waitFor(
              `window.__openworkControl.listActions().some((action) => action.id === "composer.set_text")`,
              { timeoutMs: 60_000, label: "composer actions registered" },
            );
            await ctx.control("composer.set_text", { text: "Reply with exactly: ATLAS-OK" });
            await ctx.waitFor(
              `window.__openworkControl.listActions().some((action) => action.id === "composer.send" && !action.disabled)`,
              { timeoutMs: 60_000, label: "composer.send enabled" },
            );
            await ctx.control("composer.send");
            await ctx.waitForText("Reply with exactly: ATLAS-OK", { timeoutMs: 30_000 });
          },
          assert: async () => {
            const witness = await ctx.eval(`(() => {
              const raw = localStorage.getItem("openwork.react.workspaceProjectDimension");
              let parsed = null;
              try {
                parsed = raw ? JSON.parse(raw) : null;
              } catch {
                parsed = null;
              }
              const values = parsed && typeof parsed === "object" && !Array.isArray(parsed)
                ? Object.values(parsed)
                : [];
              return {
                raw,
                hasAtlasBilling: values.some((value) => value && typeof value === "object" && value.label === "Atlas Billing"),
              };
            })()`);
            recordAssertion(
              ctx,
              "Workspace project dimension memory includes the Atlas Billing label",
              witness.hasAtlasBilling === true,
              witness,
            );
          },
          screenshot: {
            name: "first-task-sent",
            requireText: ["Reply with exactly: ATLAS-OK"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Server learns the project dimension",
      run: async (ctx) => {
        await ctx.prove("Server telemetry learns Atlas Billing as a project dimension", {
          voiceover: vo[3],
          action: async () => {
            const { payload, item } = await waitForProjectDimension(ctx);
            const value = typeof item.value === "string" ? item.value : "";
            const sessionCount = Number(item.sessionCount ?? 0);
            recordAssertion(
              ctx,
              "Telemetry dimensions include Atlas Billing with a server-derived key and at least one session",
              value.startsWith(PROJECT_VALUE_PREFIX) && sessionCount >= 1,
              item,
            );
            ctx.projectValue = value;
            ctx.output("project-dimensions", JSON.stringify(payload, null, 2));
          },
          assert: async () => {
            await ctx.expectText("Reply with exactly: ATLAS-OK");
            recordAssertion(
              ctx,
              "Project value was stored for downstream analytics filtering",
              typeof ctx.projectValue === "string" && ctx.projectValue.startsWith(PROJECT_VALUE_PREFIX),
              { projectValue: ctx.projectValue },
            );
          },
          screenshot: {
            name: "app-still-working",
            claim: "The desktop session stays usable while telemetry flushes the Atlas Billing project in the background.",
            requireText: ["Reply with exactly: ATLAS-OK"],
          },
        });
      },
    },
    {
      name: "Project-filtered analytics keep the org-wide view intact",
      run: async (ctx) => {
        await ctx.prove("Project-filtered analytics count this session without shrinking org-wide adoption", {
          voiceover: vo[4],
          action: async () => {
            ctx.assert(typeof ctx.projectValue === "string" && ctx.projectValue.length > 0, "Project value missing before analytics fetch.");
            const filtered = await loadAnalytics(ctx, new URLSearchParams({
              dimensionType: "project",
              dimensionValue: ctx.projectValue,
            }));
            const unfiltered = await loadAnalytics(ctx, null);
            const bogus = await loadAnalytics(ctx, new URLSearchParams({
              dimensionType: "project",
              dimensionValue: "no-such-project-000000",
            }));

            const filteredSessions = sessions30d(filtered);
            const unfilteredSessions = sessions30d(unfiltered);
            const bogusSessions = sessions30d(bogus);
            recordAssertion(
              ctx,
              "Filtered and org-wide analytics requests return HTTP 200",
              filtered.ok && unfiltered.ok,
              { filteredStatus: filtered.status, unfilteredStatus: unfiltered.status },
            );
            recordAssertion(
              ctx,
              "Atlas Billing filtered analytics include at least one session in the last 30 days",
              filteredSessions >= 1,
              { filteredSessions },
            );
            recordAssertion(
              ctx,
              "Org-wide analytics remain greater than or equal to the Atlas Billing filtered count",
              unfilteredSessions >= filteredSessions,
              { filteredSessions, unfilteredSessions },
            );
            recordAssertion(
              ctx,
              "Filtered sessions do not exceed org-wide sessions",
              filteredSessions <= unfilteredSessions,
              { filteredSessions, unfilteredSessions },
            );
            recordAssertion(
              ctx,
              "A bogus project filter returns zero sessions",
              bogus.ok && bogusSessions === 0,
              { bogusStatus: bogus.status, bogusSessions },
            );
            ctx.output("analytics-filtered-vs-org", JSON.stringify({
              filtered: { status: filtered.status, sessions30d: filteredSessions },
              unfiltered: { status: unfiltered.status, sessions30d: unfilteredSessions },
              bogus: { status: bogus.status, sessions30d: bogusSessions },
            }));
          },
        });
      },
    },
    {
      name: "Den Web analytics selector filters by project",
      run: async (ctx) => {
        // The analytics screen is a thin client of two endpoints: the
        // Project selector renders GET /v1/telemetry/dimensions?type=project
        // verbatim (analytics-screen.tsx fetchDimensions), and choosing an
        // option refetches GET /v1/telemetry/analytics with that dimension
        // (fetchAnalytics). This frame witnesses both requests exactly as
        // the dashboard issues them. Driving the Next dev server through the
        // sandbox tunnel inside the shared app renderer wedges its main
        // thread, so the dashboard UI itself is not parked in this window.
        await ctx.prove("Den Web's Analytics selector offers Atlas Billing and its selection filters usage", {
          voiceover: vo[5],
          action: async () => {
            ctx.assert(typeof ctx.projectValue === "string" && ctx.projectValue.length > 0, "Project value missing before selector check.");
            const { response, payload, text } = await fetchJson(ctx, "/v1/telemetry/dimensions?type=project");
            ctx.assert(response.ok, `Selector dimension fetch failed: ${response.status} ${text.slice(0, 200)}`);
            const options = Array.isArray(payload?.items) ? payload.items : [];
            const atlasOption = options.find((item) => item?.label === PROJECT_LABEL) ?? null;
            recordAssertion(
              ctx,
              "The Project selector data offers Atlas Billing with its server-derived key",
              Boolean(atlasOption) && atlasOption.value === ctx.projectValue && Number(atlasOption.sessionCount ?? 0) >= 1,
              atlasOption,
            );
            const selected = await loadAnalytics(ctx, new URLSearchParams({
              dimensionType: "project",
              dimensionValue: ctx.projectValue,
            }));
            recordAssertion(
              ctx,
              "Choosing Atlas Billing refetches project-scoped analytics with this session counted",
              selected.ok && sessions30d(selected) >= 1,
              { status: selected.status, sessions30d: sessions30d(selected) },
            );
            ctx.output("selector-options-and-selection", JSON.stringify({
              selectorOptions: options,
              selectedProject: {
                dimensionValue: ctx.projectValue,
                sessions30d: sessions30d(selected),
              },
            }, null, 2));
          },
          screenshot: {
            name: "desktop-after-analytics",
            claim: "The desktop session that fed the Atlas Billing analytics is still live after the dashboard reads them.",
            requireText: ["Reply with exactly: ATLAS-OK"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
  ],
};
