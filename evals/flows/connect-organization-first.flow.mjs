import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "connect-organization-first";
const ORG_STATUS = '[data-testid="connect-org-status-row"]';
const ORG_SECTION = '[data-testid="connect-organization-section"]';
const AGENT_ACCESS = '[data-testid="agent-access-section"]';
const DIAGNOSTICS = '[data-testid="connect-diagnostics-section"]';
const RUN_DIAGNOSTICS = '[data-testid="run-agent-diagnostics"]';
const DEN_API_URL = (process.env.OPENWORK_EVAL_DEN_API_URL ?? "").replace(/\/+$/, "");
const DEN_TOKEN = process.env.OPENWORK_EVAL_DEN_TOKEN ?? "";

const vo = await loadVoiceoverParagraphs(FLOW_ID);

async function setDesktopViewport(ctx) {
  if (!ctx.client?.send) return;
  await ctx.client.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

async function ensureSignedIn(ctx) {
  await ctx.waitFor("Boolean(window.__openworkControl)", {
    timeoutMs: 60_000,
    label: "OpenWork control API",
  });
  await ctx.control("eval.auth.set-base-url", { baseUrl: DEN_API_URL });

  const response = await fetch(`${DEN_API_URL}/v1/auth/desktop-handoff`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${DEN_TOKEN}`,
      "content-type": "application/json",
      origin: DEN_API_URL,
    },
    body: JSON.stringify({ desktopScheme: "openwork" }),
  });
  const body = await response.json();
  ctx.assert(response.ok && typeof body.grant === "string", `Desktop handoff creation failed: ${response.status}`);
  await ctx.control("auth.exchange-grant", { grant: body.grant, baseUrl: DEN_API_URL });
  await ctx.waitFor(`(() => {
    return Boolean(
      (localStorage.getItem("openwork.den.authToken") ?? "").trim()
      && (localStorage.getItem("openwork.den.activeOrgId") ?? "").trim()
    );
  })()`, { timeoutMs: 60_000, label: "signed-in organization session" });
}

async function navigateToConnect(ctx) {
  await ctx.waitFor("Boolean(window.__openworkControl)", {
    timeoutMs: 60_000,
    label: "OpenWork control API",
  });
  const workspaceId = await ctx.eval(`(() => {
    const route = window.__openworkControl?.snapshot?.().route ?? location.hash;
    return (String(route).match(/\\/workspace\\/([^/]+)/) ?? [])[1]
      ?? localStorage.getItem("openwork.react.activeWorkspace")
      ?? "";
  })()`);
  await ctx.navigateHash(workspaceId
    ? `/workspace/${workspaceId}/settings/connect`
    : "/settings/connect");
  await ctx.waitFor(`(() => {
    return Boolean(
      document.querySelector(${JSON.stringify(ORG_STATUS)})
      && document.querySelector(${JSON.stringify(ORG_SECTION)})
      && document.querySelector(${JSON.stringify(AGENT_ACCESS)})
      && document.querySelector(${JSON.stringify(DIAGNOSTICS)})
      && document.querySelector(${JSON.stringify(RUN_DIAGNOSTICS)})
    );
  })()`, { timeoutMs: 60_000, label: "active Connect organization content" });
}

async function readSectionOrder(ctx) {
  return ctx.eval(`(() => {
    const selectors = ${JSON.stringify({ ORG_STATUS, ORG_SECTION, AGENT_ACCESS, DIAGNOSTICS, RUN_DIAGNOSTICS })};
    const elements = Object.fromEntries(
      Object.entries(selectors).map(([key, selector]) => [key, document.querySelector(selector)]),
    );
    const top = (element) => element.getBoundingClientRect().top + window.scrollY;
    return {
      statusTop: top(elements.ORG_STATUS),
      organizationTop: top(elements.ORG_SECTION),
      agentAccessTop: top(elements.AGENT_ACCESS),
      diagnosticsTop: top(elements.DIAGNOSTICS),
      runDiagnosticsInsideSection: elements.DIAGNOSTICS.contains(elements.RUN_DIAGNOSTICS),
    };
  })()`);
}

export default {
  id: FLOW_ID,
  title: "Connect prioritizes organization connections before diagnostics",
  kind: "user-facing",
  spec: "evals/voiceovers/connect-organization-first.md",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_TOKEN"],
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("Organization connections are the first actionable Connect content", {
          voiceover: vo[0],
          action: async () => {
            await setDesktopViewport(ctx);
            await ensureSignedIn(ctx);
            await navigateToConnect(ctx);
            await ctx.eval(`document.querySelector(${JSON.stringify(ORG_STATUS)})?.scrollIntoView({ block: "start", behavior: "instant" }); true`);
          },
          assert: async () => {
            const order = await readSectionOrder(ctx);
            ctx.assert(order.statusTop < order.organizationTop, `Organization status did not precede the connection list: ${JSON.stringify(order)}`);
            ctx.assert(order.organizationTop < order.agentAccessTop, `Organization connections did not precede agent access: ${JSON.stringify(order)}`);
            ctx.assert(order.agentAccessTop < order.diagnosticsTop, `Agent access did not precede diagnostics: ${JSON.stringify(order)}`);
            await ctx.expectHashIncludes("/settings/connect");
            await ctx.expectText("From your organization");
          },
          screenshot: {
            name: "organization-connections-first",
            claim: "The active organization and its shared connections appear before support diagnostics.",
            requireText: ["From your organization", "Cloud-runnable plugins and team connections appear here."],
            rejectText: ["Something went wrong", "Choose your organization"],
            hashIncludes: "/settings/connect",
          },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("Agent health and diagnostics remain available below organization connections", {
          voiceover: vo[1],
          action: async () => {
            await ctx.eval(`document.querySelector(${JSON.stringify(AGENT_ACCESS)})?.scrollIntoView({ block: "start", behavior: "instant" }); true`);
          },
          assert: async () => {
            const order = await readSectionOrder(ctx);
            ctx.assert(order.organizationTop < order.agentAccessTop, `Organization content no longer precedes agent access: ${JSON.stringify(order)}`);
            ctx.assert(order.agentAccessTop < order.diagnosticsTop, `Diagnostics no longer follows agent access: ${JSON.stringify(order)}`);
            ctx.assert(order.runDiagnosticsInsideSection, "Run agent diagnostics escaped the diagnostics section.");
            await ctx.expectText("Agent access to connected services");
            await ctx.expectText("Run agent diagnostics");
          },
          screenshot: {
            name: "diagnostics-remain-below",
            claim: "Agent access health and diagnostics remain available beneath organization content.",
            requireText: ["Agent access to connected services", "Run agent diagnostics"],
            rejectText: ["Something went wrong"],
            hashIncludes: "/settings/connect",
          },
        });
      },
    },
  ],
};
