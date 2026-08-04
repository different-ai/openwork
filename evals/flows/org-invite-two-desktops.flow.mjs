import { journeys } from "../runner/journeys/index.mjs";
import { defineScenario } from "../runner/scenario.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "org-invite-two-desktops";
const REQUIRED_DEN_ENV = ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"];
const ALEX_REPLY = "alex hello script ready";
const JAMIE_REPLY = "jamie hello script ready";

const vo = await loadVoiceoverParagraphs(FLOW_ID);
if (!vo) throw new Error(`Missing approved voice-over script for ${FLOW_ID}.`);

const { den, desktop } = journeys;

function cleanBaseUrl(value) {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

function requiredEnv(ctx, name) {
  const value = ctx.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for ${FLOW_ID}.`);
  return value;
}

function denBootstrap(ctx) {
  return {
    baseUrl: requiredEnv(ctx, "OPENWORK_EVAL_DEN_WEB_URL"),
    apiBaseUrl: requiredEnv(ctx, "OPENWORK_EVAL_DEN_API_URL"),
    requireSignin: false,
  };
}

function stateString(ctx, key) {
  const value = ctx.state[key];
  if (typeof value === "string" && value.trim()) return value;
  throw new Error(`Scenario state ${key} was not set.`);
}

function optionalStateString(ctx, key) {
  const value = ctx.state[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function inviteRef(ctx) {
  const value = ctx.state.invite;
  if (value && typeof value === "object") return value;
  throw new Error("Scenario state invite was not set.");
}

function witness(ctx, condition, assertion, actual) {
  ctx.recordEvidence({ type: "assertion", status: condition ? "passed" : "failed", assertion, actual });
  ctx.assert(condition, assertion);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function retryTransientCdp(ctx, label, operation) {
  try {
    return await operation();
  } catch (error) {
    if (!errorMessage(error).includes("Promise was collected")) throw error;
    ctx.log(`${label} hit transient CDP promise collection; retrying once.`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    return operation();
  }
}

async function waitForWithCdpReconnect(ctx, expression, options) {
  try {
    return await ctx.waitFor(expression, options);
  } catch (error) {
    if (!errorMessage(error).includes("CDP call Runtime.evaluate timed out")) throw error;
    ctx.log(`${options.label} hit a stalled CDP evaluate; reconnecting once.`);
    await ctx.reconnect();
    return ctx.waitFor(expression, options);
  }
}

function expectAgentReply(ctx) {
  return Boolean(ctx.env.OPENWORK_EVAL_EXPECT_AGENT_REPLY?.trim());
}

function runSalt(ctx) {
  const existing = optionalStateString(ctx, "runSalt");
  if (existing) return existing;
  const seed = ctx.env.OPENWORK_EVAL_RUNSTAMP?.trim() || new Date().toISOString();
  const safe = `${seed}-${process.pid}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "run";
  const salt = `owt-${safe}`;
  ctx.state.runSalt = salt;
  return salt;
}

function alexPrompt(ctx) {
  const salt = runSalt(ctx);
  return `Run salt ${salt}. Write a short hello script for Alex's new team. Include exactly this phrase: ${ALEX_REPLY}.`;
}

function jamiePrompt(ctx) {
  const salt = runSalt(ctx);
  return `Run salt ${salt}. Write Jamie's first hello task for the new org. Include exactly this phrase: ${JAMIE_REPLY}.`;
}

function uniqueOrgDetails(ctx) {
  const stamp = ctx.env.OPENWORK_EVAL_RUNSTAMP?.trim()
    || new Date().toISOString().slice(11, 16).replace(":", "");
  const safe = `${stamp}-${process.pid}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "run";
  return {
    name: `Acme Skunkworks ${safe}`,
    slug: `acme-skunkworks-${safe}`,
  };
}

function orgConnectOptions(ctx, surface, actor) {
  const organizationId = optionalStateString(ctx, "orgId");
  return {
    surface,
    actor,
    organizationId,
    organizationName: stateString(ctx, "orgName"),
  };
}

async function currentRoute(ctx) {
  const route = await ctx.eval(`(() => {
    const hashRoute = window.location.hash.replace(/^#/, '');
    if (hashRoute.includes('/workspace/')) return hashRoute;
    try {
      const snapshotRoute = window.__openworkControl?.snapshot?.().route;
      if (typeof snapshotRoute === 'string' && snapshotRoute) return snapshotRoute;
    } catch {}
    return hashRoute || window.location.pathname;
  })()`);
  return typeof route === "string" ? route : "";
}

async function rememberWorkspaceRoute(ctx, surface, key) {
  await ctx.on(surface, async () => {
    const route = await currentRoute(ctx);
    witness(ctx, route.includes("/workspace/") || route === "/session", `Usable desktop route captured for ${surface.handle.name}`, route);
    ctx.state[key] = route;
  });
}

async function returnToWorkspace(ctx, surface, key) {
  const route = stateString(ctx, key);
  await ctx.on(surface, async () => {
    await ctx.navigateHash(route);
    const predicate = route === "/session"
      ? `(() => {
        const current = window.__openworkControl?.snapshot?.().route || window.location.hash.replace(/^#/, '');
        return current === '/session' || current.includes('/session');
      })()`
      : `(() => {
        const current = window.__openworkControl?.snapshot?.().route || window.location.hash.replace(/^#/, '');
        const hashRoute = window.location.hash.replace(/^#/, '');
        return current === ${JSON.stringify(route)} || hashRoute === ${JSON.stringify(route)};
      })()`;
    await ctx.waitFor(predicate, { timeoutMs: 30_000, label: `return to ${route}` });
  });
}

async function navigateDenMembers(ctx) {
  const webUrl = cleanBaseUrl(requiredEnv(ctx, "OPENWORK_EVAL_DEN_WEB_URL"));
  // Structured CDP navigation: no code construction from env-derived URLs.
  await ctx.client.send("Page.navigate", { url: new URL("/dashboard/members", `${webUrl}/`).toString() });
  await waitForWithCdpReconnect(ctx, "document.readyState === 'complete'", { timeoutMs: 45_000, label: "load Den members page" });
  await waitForWithCdpReconnect(ctx, "document.body.innerText.includes('Members') || document.body.innerText.includes('Add member')", {
    timeoutMs: 45_000,
    label: "Den members page",
  });
}

async function showDenOrganizationList(ctx) {
  const webUrl = cleanBaseUrl(requiredEnv(ctx, "OPENWORK_EVAL_DEN_WEB_URL"));
  const orgName = stateString(ctx, "orgName");
  // Structured CDP navigation: no code construction from env-derived URLs.
  await ctx.client.send("Page.navigate", { url: new URL("/organization", `${webUrl}/`).toString() });
  await waitForWithCdpReconnect(ctx, "document.readyState === 'complete'", { timeoutMs: 45_000, label: "load Den organization list" });
  await waitForWithCdpReconnect(ctx, "document.body.innerText.includes('Organizations')", { timeoutMs: 45_000, label: "Den organization list" });
  await ctx.eval(`(() => {
    const input = document.querySelector('input[placeholder="Search organizations"]');
    if (!(input instanceof HTMLInputElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, ${JSON.stringify(orgName)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (await ctx.hasText(orgName)) return;
    const clickedMore = await ctx.eval(`(() => {
      const normalize = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
      const button = [...document.querySelectorAll('button')]
        .find((entry) => normalize(entry.textContent).startsWith('Show more') && entry.disabled !== true);
      button?.scrollIntoView({ block: 'center', inline: 'center' });
      button?.click();
      return Boolean(button);
    })()`);
    if (!clickedMore) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  await ctx.expectText(orgName, { timeoutMs: 45_000 });
}

async function waitForDenDashboard(ctx) {
  const webUrl = cleanBaseUrl(requiredEnv(ctx, "OPENWORK_EVAL_DEN_WEB_URL"));
  await waitForWithCdpReconnect(ctx,
    `location.href.startsWith(${JSON.stringify(webUrl)}) && location.pathname.startsWith('/dashboard')`,
    { timeoutMs: 45_000, label: "Den dashboard route" },
  );
}

async function runDesktopPrompt(ctx, surface, prompt, visibleTexts, replyToken) {
  const result = await desktop.runPrompt(ctx, {
    surface,
    prompt,
    expectResponse: expectAgentReply(ctx),
  });
  const route = result.sessionRoute || await ctx.on(surface, async () => currentRoute(ctx));
  witness(ctx, typeof route === "string" && route.includes("/session"), `Session route is active for ${surface.handle.name}`, route);
  await ctx.on(surface, async () => {
    for (const visibleText of visibleTexts) {
      await ctx.expectText(visibleText, { timeoutMs: 60_000 });
    }
    if (expectAgentReply(ctx)) await ctx.expectText(replyToken, { timeoutMs: 120_000 });
  });
  return route;
}

export default defineScenario({
  id: FLOW_ID,
  title: "An admin creates an org, invites a teammate, and both run agents from separate desktops",
  kind: "user-facing",
  stage: { den: { orgMode: "multi_org" } },
  actors: {
    alex: "owner",
    jamie: { persona: "fresh", prefix: "jamie" },
  },
  requiredEnv: REQUIRED_DEN_ENV,
  steps: [
    {
      name: "Alex signs in on Den Web",
      run: async (ctx) => {
        const alexWeb = await ctx.surfaces.chrome("alex-web");
        await ctx.on(alexWeb, async () => {
          await ctx.prove("Alex is signed in to the cloud dashboard in her own Chrome profile", {
            voiceover: vo[0],
            action: async () => {
              await den.signInWeb(ctx, { surface: alexWeb, actor: ctx.actors.alex });
              await waitForDenDashboard(ctx);
            },
            assert: async () => {
              await ctx.expectText("Dashboard", { timeoutMs: 60_000 });
            },
            screenshot: { name: "alex-den-dashboard", requireText: ["Dashboard"] },
          });
        });
      },
    },
    {
      name: "Alex creates the org",
      run: async (ctx) => {
        const alexWeb = ctx.surfaces.get("alex-web");
        const screenshot = { name: "alex-new-org-visible", requireText: [] };
        await ctx.on(alexWeb, async () => {
          await ctx.prove("Alex creates a unique organization and Den Web scopes to it", {
            voiceover: vo[1],
            action: async () => {
              const details = uniqueOrgDetails(ctx);
              const org = await den.createOrg(ctx, {
                surface: alexWeb,
                actor: ctx.actors.alex,
                name: details.name,
                slug: details.slug,
              });
              ctx.state.orgName = org.name;
              ctx.state.orgSlug = org.slug;
              if (org.orgId) ctx.state.orgId = org.orgId;
              await showDenOrganizationList(ctx);
            },
            assert: async () => {
              const orgName = stateString(ctx, "orgName");
              screenshot.requireText.push("Organizations", orgName);
              await ctx.expectText(orgName, { timeoutMs: 60_000 });
            },
            screenshot,
          });
        });
      },
    },
    {
      name: "Alex desktop connects to the org",
      run: async (ctx) => {
        const alexDesktop = await ctx.surfaces.electron("alex-desktop", { profile: "fresh", bootstrap: denBootstrap(ctx) });
        await ctx.on(alexDesktop, async () => {
          await ctx.prove("Alex's fresh desktop boots, connects to Den, and shows her cloud account", {
            voiceover: vo[2],
            action: async () => {
              const boot = await desktop.firstBoot(ctx, { surface: alexDesktop });
              ctx.state.alexWorkspacePath = boot.workspacePath;
              const connection = await retryTransientCdp(ctx, "Alex desktop Den connect", () => desktop.connectDen(ctx, orgConnectOptions(ctx, alexDesktop, ctx.actors.alex)));
              if (connection.activeOrgName) ctx.state.alexActiveOrgName = connection.activeOrgName;
              await ctx.navigateHash("/session");
              await ctx.waitFor(`(() => {
                const route = window.__openworkControl?.snapshot?.().route || window.location.hash.replace(/^#/, '');
                return route === '/session' || route.includes('/session');
              })()`, { timeoutMs: 30_000, label: "Alex session route" });
              await rememberWorkspaceRoute(ctx, alexDesktop, "alexWorkspaceRoute");
            },
            assert: async () => {
              await ctx.expectText(ctx.actors.alex.email, { timeoutMs: 30_000 });
            },
            screenshot: { name: "alex-desktop-connected", requireText: [ctx.actors.alex.email] },
          });
        });
      },
    },
    {
      name: "Alex runs a hello-script task",
      run: async (ctx) => {
        const alexDesktop = ctx.surfaces.get("alex-desktop");
        const screenshot = { name: "alex-task-running", requireText: ["hello script"], hashIncludes: "/session" };
        await ctx.on(alexDesktop, async () => {
          await ctx.prove("Alex's desktop starts a hello-script task in a session", {
            voiceover: vo[3],
            action: async () => {
              await returnToWorkspace(ctx, alexDesktop, "alexWorkspaceRoute");
              const salt = runSalt(ctx);
              ctx.state.alexSessionRoute = await runDesktopPrompt(ctx, alexDesktop, alexPrompt(ctx), ["hello script", salt], ALEX_REPLY);
            },
            assert: async () => {
              screenshot.requireText.push(runSalt(ctx));
              witness(ctx, stateString(ctx, "alexSessionRoute").includes("/session"), "Alex's prompt produced a session route", ctx.state.alexSessionRoute);
              if (expectAgentReply(ctx)) screenshot.requireText.push(ALEX_REPLY);
            },
            screenshot,
          });
        });
      },
    },
    {
      name: "Alex invites Jamie",
      run: async (ctx) => {
        const alexWeb = ctx.surfaces.get("alex-web");
        const screenshot = { name: "jamie-pending-invite", requireText: [] };
        await ctx.on(alexWeb, async () => {
          await ctx.prove("Alex invites Jamie and the invite is pending in the org", {
            voiceover: vo[4],
            action: async () => {
              ctx.state.invite = await den.inviteMember(ctx, {
                surface: alexWeb,
                actor: ctx.actors.alex,
                email: ctx.actors.jamie.email,
                organizationId: optionalStateString(ctx, "orgId"),
              });
              await navigateDenMembers(ctx);
            },
            assert: async () => {
              screenshot.requireText.push("Members", ctx.actors.jamie.email, "Pending");
              await ctx.expectText("Members", { timeoutMs: 45_000 });
              await ctx.expectText(ctx.actors.jamie.email, { timeoutMs: 45_000 });
              await ctx.expectText("Pending", { timeoutMs: 45_000 });
              const invite = inviteRef(ctx);
              witness(ctx, Boolean(invite.inviteUrl || invite.token), "Jamie's invite URL or token was captured", invite);
            },
            screenshot,
          });
        });
      },
    },
    {
      name: "Jamie accepts from her Chrome",
      run: async (ctx) => {
        const jamieWeb = await ctx.surfaces.chrome("jamie-web", { profile: "fresh" });
        await ctx.on(jamieWeb, async () => {
          await ctx.prove("Jamie accepts the invite from a separate Chrome profile and lands in the org", {
            voiceover: vo[5],
            action: async () => {
              const accepted = await den.acceptInvite(ctx, {
                surface: jamieWeb,
                actor: ctx.actors.jamie,
                invite: inviteRef(ctx),
                allowApiFallback: false,
              });
              ctx.state.jamieInviteStatus = accepted.status;
            },
            assert: async () => {
              await ctx.expectText("You're in", { timeoutMs: 60_000 });
              await ctx.expectText(stateString(ctx, "orgName"), { timeoutMs: 60_000 });
              witness(ctx, ctx.state.jamieInviteStatus === "accepted", "Jamie accepted the organization invite", ctx.state.jamieInviteStatus);
            },
            screenshot: { name: "jamie-accepted-org", requireText: ["You're in", stateString(ctx, "orgName")] },
          });
        });
      },
    },
    {
      name: "Jamie desktop spawns fresh",
      run: async (ctx) => {
        const jamieDesktop = await ctx.surfaces.electron("jamie-desktop", { profile: "fresh", bootstrap: denBootstrap(ctx) });
        await ctx.on(jamieDesktop, async () => {
          await ctx.prove("A second fresh desktop is alive for Jamie mid-scenario", {
            voiceover: vo[6],
            action: async () => {
              const boot = await desktop.firstBoot(ctx, { surface: jamieDesktop });
              ctx.state.jamieWorkspacePath = boot.workspacePath;
              await rememberWorkspaceRoute(ctx, jamieDesktop, "jamieWorkspaceRoute");
            },
            assert: async () => {
              const route = stateString(ctx, "jamieWorkspaceRoute");
              witness(ctx, route.includes("/workspace/") || route === "/session", "Jamie desktop reached a fresh usable route", ctx.state.jamieWorkspaceRoute);
              await ctx.expectText("OpenWork", { timeoutMs: 30_000 });
              await ctx.expectNoText(ctx.actors.alex.email);
            },
            screenshot: { name: "jamie-fresh-desktop", requireText: ["OpenWork"], rejectText: [ctx.actors.alex.email] },
          });
        });
      },
    },
    {
      name: "Jamie connects and runs her task",
      run: async (ctx) => {
        const jamieDesktop = ctx.surfaces.get("jamie-desktop");
        const screenshot = { name: "jamie-task-running", requireText: ["Jamie's first hello", ctx.actors.jamie.email], rejectText: [ctx.actors.alex.email], hashIncludes: "/session" };
        await ctx.on(jamieDesktop, async () => {
          await ctx.prove("Jamie signs in on her desktop and starts her own task in the shared org", {
            voiceover: vo[7],
            action: async () => {
              await returnToWorkspace(ctx, jamieDesktop, "jamieWorkspaceRoute");
              const connection = await retryTransientCdp(ctx, "Jamie desktop Den connect", () => desktop.connectDen(ctx, orgConnectOptions(ctx, jamieDesktop, ctx.actors.jamie)));
              if (connection.activeOrgName) ctx.state.jamieActiveOrgName = connection.activeOrgName;
              const salt = runSalt(ctx);
              ctx.state.jamieSessionRoute = await runDesktopPrompt(ctx, jamieDesktop, jamiePrompt(ctx), ["Jamie's first hello", salt, ctx.actors.jamie.email], JAMIE_REPLY);
            },
            assert: async () => {
              screenshot.requireText.push(runSalt(ctx));
              await ctx.expectNoText(ctx.actors.alex.email);
              witness(ctx, stateString(ctx, "jamieSessionRoute").includes("/session"), "Jamie's prompt produced a session route", ctx.state.jamieSessionRoute);
              if (expectAgentReply(ctx)) screenshot.requireText.push(JAMIE_REPLY);
            },
            screenshot,
          });
        });
      },
    },
  ],
});
