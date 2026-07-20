import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script (evals/voiceovers/provider-sync-stable-engine.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("provider-sync-stable-engine");

const PROVIDER_NAME = "Acme Azure Foundry";
const RELOAD_TEXT = "Reloading OpenCode config";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function denRequest(ctx, path, init = {}) {
  const apiBase = ctx.env.OPENWORK_EVAL_DEN_API_URL.trim().replace(/\/+$/, "");
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${ctx.env.OPENWORK_EVAL_DEN_TOKEN.trim()}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await response.text();
  ctx.assert(response.ok, `${init.method ?? "GET"} ${path} failed: ${response.status} ${body.slice(0, 200)}`);
  return body ? JSON.parse(body) : null;
}

async function readRouteInfo(ctx) {
  return await ctx.eval(`(() => {
    const hash = location.hash;
    const workspaceMatch = hash.match(/^#\\/workspace\\/(ws_[a-z0-9]+)\\//i);
    const sessionMatch = hash.match(/^#(\\/workspace\\/ws_[a-z0-9]+\\/session\\/ses_[A-Za-z0-9]+)/);
    return {
      hash,
      workspaceId: workspaceMatch ? workspaceMatch[1] : "",
      sessionPath: sessionMatch ? sessionMatch[1] : "",
    };
  })()`);
}

async function rememberSessionRoute(ctx) {
  const route = await readRouteInfo(ctx);
  if (route?.workspaceId) ctx.workspaceId = route.workspaceId;
  if (route?.sessionPath) ctx.sessionPath = route.sessionPath;
  return route;
}

async function ensureSessionRoute(ctx) {
  const hash = await ctx.eval("location.hash");
  if (typeof hash === "string" && hash.includes("/session/")) {
    await rememberSessionRoute(ctx);
    return;
  }
  if (ctx.sessionPath) {
    await ctx.navigateHash(ctx.sessionPath);
  } else {
    await ctx.navigateHash("/session");
  }
  await ctx.waitFor("window.location.hash.includes('/session/')", {
    timeoutMs: 60_000,
    label: "workspace session route",
  });
  await rememberSessionRoute(ctx);
}

async function clickAcmeOrganization(ctx) {
  await ctx.clickText("Acme Robotics", {
    selector: "label, button, [role=button], [role=radio]",
    timeoutMs: 30_000,
  });
}

async function chooseAcmeIfPickerVisible(ctx) {
  if (!(await ctx.hasText("Choose your organization"))) return false;
  await clickAcmeOrganization(ctx);
  await ctx.clickText("Continue with organization", { timeoutMs: 30_000 });
  return true;
}

const workspaceConfigStateExpr = (workspaceId) => `(async () => {
  try {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    const workspaceId = ${JSON.stringify(workspaceId)};
    if (!port || !token || !workspaceId) {
      return JSON.stringify({ providers: [], runtimeProviders: [], error: "missing server port/token/workspace" });
    }
    const response = await fetch("http://127.0.0.1:" + port + "/workspace/" + workspaceId + "/config", {
      headers: { Authorization: "Bearer " + token },
    });
    if (!response.ok) {
      return JSON.stringify({ providers: [], runtimeProviders: [], error: "config status " + response.status });
    }
    const config = await response.json();
    return JSON.stringify({
      providers: Object.keys(config.openwork?.cloudImports?.providers ?? {}),
      runtimeProviders: Object.keys(config.opencode?.provider ?? {}),
    });
  } catch (error) {
    return JSON.stringify({
      providers: [],
      runtimeProviders: [],
      error: error instanceof Error ? error.message : String(error),
    });
  }
})()`;

async function readWorkspaceConfigState(ctx) {
  const raw = await ctx.eval(workspaceConfigStateExpr(ctx.workspaceId), { awaitPromise: true });
  ctx.assert(typeof raw === "string", "Workspace config read returned no state.");
  const parsed = JSON.parse(raw);
  return {
    providers: Array.isArray(parsed.providers) ? parsed.providers : [],
    runtimeProviders: Array.isArray(parsed.runtimeProviders) ? parsed.runtimeProviders : [],
    error: typeof parsed.error === "string" ? parsed.error : "",
  };
}

function lprKeys(values) {
  return values.filter((value) => typeof value === "string" && value.startsWith("lpr_"));
}

async function pollWorkspaceConfigState(ctx, predicate, timeoutMs, label) {
  const startedAt = Date.now();
  let lastState = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastState = await readWorkspaceConfigState(ctx).catch((error) => ({
      providers: [],
      runtimeProviders: [],
      error: error instanceof Error ? error.message : String(error),
    }));
    if (predicate(lastState)) return lastState;
    await sleep(2_000);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}. Last state: ${JSON.stringify(lastState)}`);
}

async function openCloudProvidersView(ctx) {
  await ctx.navigateHash("/settings/cloud-providers");
  await ctx.waitFor("window.location.hash.includes('/settings/cloud-providers')", {
    timeoutMs: 20_000,
    label: "cloud providers settings route",
  });
  await ctx.clickText("Refresh", { selector: "button", timeoutMs: 30_000 }).catch(() => {
    ctx.log("Cloud providers Refresh button was not available; waiting for current list.");
  });
  await ctx.waitForText(PROVIDER_NAME, { timeoutMs: 60_000 });
}

export default {
  id: "provider-sync-stable-engine",
  title: "Org cloud providers import once and the engine connection stays stable",
  kind: "user-facing",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_TOKEN", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("A clean signed-out workspace boots to a quiet session surface", {
          voiceover: vo[0],
          // "Alex starts on a clean workspace, signed out of the cloud — the composer is "
          action: async () => {
            await ctx.waitFor("Boolean(window.__openworkControl)", {
              timeoutMs: 60_000,
              label: "control API",
            });
            const route = await rememberSessionRoute(ctx);
            ctx.assert(Boolean(route?.workspaceId), `Could not parse workspace id from hash: ${route?.hash ?? ""}`);
            ctx.assert(Boolean(route?.sessionPath), `Could not parse session route from hash: ${route?.hash ?? ""}`);
          },
          assert: async () => {
            await ctx.expectText("Describe your task", { timeoutMs: 30_000 });
            await ctx.expectNoText(RELOAD_TEXT);
          },
          screenshot: {
            name: "signed-out-session",
            requireText: ["Describe your task"],
            rejectText: [RELOAD_TEXT],
          },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("Desktop handoff sign-in lands on the org picker and Alex picks Acme Robotics", {
          voiceover: vo[1],
          // "He signs in to OpenWork Cloud with a pasted sign-in code and lands on the or"
          action: async () => {
            const payload = await denRequest(ctx, "/v1/auth/desktop-handoff", {
              method: "POST",
              body: JSON.stringify({ desktopScheme: "openwork" }),
            });
            ctx.assert(
              typeof payload?.openworkUrl === "string" && payload.openworkUrl.length > 0,
              "No openworkUrl in handoff response.",
            );
            const handoffUrl = new URL(payload.openworkUrl);
            handoffUrl.searchParams.set("denBaseUrl", ctx.env.OPENWORK_EVAL_DEN_WEB_URL.trim().replace(/\/+$/, ""));
            ctx.handoffUrl = handoffUrl.toString();

            await ctx.navigateHash("/settings/cloud-account");
            await ctx.waitFor(
              `(() => {
                const text = document.body.innerText;
                return text.includes("Paste sign-in code") || text.includes("Sign out");
              })()`,
              { timeoutMs: 30_000, label: "cloud account state" },
            );

            ctx.alreadySignedIn = await ctx.hasText("Sign out");
            if (ctx.alreadySignedIn) {
              ctx.log("Already signed in — skipping paste flow.");
            } else {
              await ctx.clickText("Paste sign-in code", { timeoutMs: 30_000 });
              await ctx.fill("#den-signin-link", ctx.handoffUrl);
              await ctx.clickText("Finish sign-in", { timeoutMs: 30_000 });
              await ctx.waitFor(
                "Boolean((localStorage.getItem('openwork.den.authToken') ?? '').trim())",
                { timeoutMs: 60_000, label: "persisted den auth token" },
              );
            }

            await ctx.navigateHash("/onboarding");
            const state = await ctx.waitFor(
              `(() => {
                const text = document.body.innerText;
                if (text.includes("Choose your organization") && text.includes("Acme Robotics")) return "picker";
                if (text.includes("You have access to the following resources") && text.includes("AI Providers")) return "resources";
                if (window.location.hash.includes("/session/")) return "session";
                return null;
              })()`,
              { timeoutMs: 60_000, label: "org picker or already-selected organization" },
            );
            ctx.orgPickerState = state;
            ctx.orgPickerSkipped = state !== "picker";
            if (ctx.orgPickerSkipped) {
              ctx.log(`Org picker was already past this state (${state}); continuing idempotently.`);
            }
          },
          assert: async () => {
            if (ctx.orgPickerSkipped) {
              ctx.recordEvidence({
                type: "assertion",
                status: "passed",
                assertion: `Org picker was already completed (${ctx.orgPickerState}); continuing idempotently.`,
              });
              return;
            }
            await ctx.expectText("Acme Robotics", { timeoutMs: 5_000 });
            await ctx.expectText("Continue with organization", { timeoutMs: 5_000 });
          },
          screenshot: {
            name: "org-picker-acme",
            get requireText() {
              return ctx.orgPickerSkipped ? [] : ["Choose your organization", "Acme Robotics"];
            },
            get hashIncludes() {
              return ctx.orgPickerSkipped ? undefined : "/onboarding";
            },
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("Org resources travel with the sign-in: AI provider models are visible before entering the workspace", {
          voiceover: vo[2],
          // "Acme's resources come with him: the onboarding summary shows the org's AI pr"
          action: async () => {
            if (ctx.orgPickerSkipped && (await ctx.eval("window.location.hash.includes('/session/')"))) {
              await ctx.navigateHash("/onboarding");
            }
            await chooseAcmeIfPickerVisible(ctx);
            await ctx.waitFor(
              `(() => {
                const text = document.body.innerText;
                return text.includes("You have access to the following resources") && text.includes("AI Providers");
              })()`,
              { timeoutMs: 60_000, label: "org resources summary" },
            );
          },
          assert: async () => {
            await ctx.expectText("AI Providers", { timeoutMs: 5_000 });
            await ctx.expectText("Continue to workspace", { timeoutMs: 5_000 });
          },
          screenshot: {
            name: "org-resources",
            requireText: ["AI Providers", "Continue to workspace"],
          },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("The org provider imported once and the import baseline is persisted in the workspace config", {
          voiceover: vo[3],
          // "The org provider imported exactly once — under the hood the workspace config"
          action: async () => {
            if (await ctx.hasText("Continue to workspace")) {
              await ctx.clickText("Continue to workspace", { timeoutMs: 30_000 });
            }
            await ctx.waitFor("window.location.hash.includes('/session/')", {
              timeoutMs: 60_000,
              label: "workspace session route after onboarding",
            });
            await rememberSessionRoute(ctx);
            ctx.configState = await pollWorkspaceConfigState(
              ctx,
              (state) => lprKeys(state.providers).length > 0 && lprKeys(state.runtimeProviders).length > 0,
              120_000,
              "cloud import baseline and runtime provider",
            );
            await openCloudProvidersView(ctx);
          },
          assert: async () => {
            const state = await readWorkspaceConfigState(ctx);
            const imported = lprKeys(state.providers);
            const runtime = lprKeys(state.runtimeProviders);
            ctx.assert(imported.length === 1, `Expected exactly one lpr_ cloud import, got ${imported.length}: ${imported.join(", ")}`);
            ctx.assert(runtime.includes(imported[0]), `Runtime providers did not include imported provider ${imported[0]}: ${runtime.join(", ")}`);
            ctx.recordEvidence({
              type: "assertion",
              status: "passed",
              assertion: `Workspace config has one cloud import (${imported[0]}) and the runtime provider includes it.`,
              actual: JSON.stringify(state),
            });
          },
          screenshot: {
            name: "provider-imported",
            requireText: [PROVIDER_NAME],
            hashIncludes: "/settings/cloud-providers",
          },
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await ctx.prove("Sixty seconds in the session with zero 'Reloading OpenCode config' flashes — the reload loop is gone", {
          voiceover: vo[4],
          // "The proof is in the waiting: a full minute in the session and the status bar"
          action: async () => {
            await ensureSessionRoute(ctx);
            await ctx.waitForText("Describe your task", { timeoutMs: 60_000 });
            await sleep(15_000);
            let positives = 0;
            for (let i = 0; i < 30; i += 1) {
              await sleep(2_000);
              if (await ctx.eval(`document.body.innerText.includes(${JSON.stringify(RELOAD_TEXT)})`)) {
                positives += 1;
              }
            }
            ctx.reloadPositiveSamples = positives;
          },
          assert: async () => {
            ctx.assert(
              ctx.reloadPositiveSamples === 0,
              `saw "${RELOAD_TEXT}" ${ctx.reloadPositiveSamples}/30 samples`,
            );
            ctx.recordEvidence({
              type: "assertion",
              status: "passed",
              assertion: `No ${RELOAD_TEXT} flashes across 30 samples.`,
            });
            await ctx.expectText("Describe your task", { timeoutMs: 5_000 });
            await ctx.expectNoText(RELOAD_TEXT);
          },
          screenshot: {
            name: "engine-stable",
            requireText: ["Describe your task"],
            rejectText: [RELOAD_TEXT],
            hashIncludes: "/session/",
          },
        });
      },
    },
  ],
};
