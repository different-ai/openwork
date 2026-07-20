import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "connect-agent-diagnostics";
const DIAGNOSTICS_PATH_RE = /\/workspace\/[^/]+\/diagnostics\/agent-context$/;
const RUN_BUTTON = '[data-testid="run-agent-diagnostics"]';
const REPORT = '[data-testid="agent-diagnostics-report"]';
const COPY_BUTTON = '[data-testid="agent-diagnostics-copy"]';
const CLOUD_CHECK = '[data-testid="agent-diagnostics-check"][data-check-id="cloud-tool-catalog"]';
const CHECK_IDS = [
  "request-safety",
  "workspace-runtime",
  "connect-steering-scope",
  "agent-resolution",
  "agent-prompt-markers",
  "agent-connect-tool-permissions",
  "plugin-registration",
  "mcp-inventory",
  "engine-config",
  "engine-agent",
  "engine-plugin-tools",
  "engine-mcp-sync",
  "engine-mcp-status",
  "cloud-tool-catalog",
  "organization-connections",
  "report-safety",
];
const ENGINE_READ_CHECKS = ["engine-config", "engine-agent"];

const vo = await loadVoiceoverParagraphs(FLOW_ID);

async function setDesktopViewport(ctx) {
  if (!ctx.client?.send) return;
  await ctx.client.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false,
  }).catch((error) => ctx.log(`Viewport setup skipped: ${error instanceof Error ? error.message : String(error)}`));
}

async function navigateToDebugDiagnostics(ctx) {
  await ctx.eval(`(() => {
    localStorage.setItem("openwork.developerMode", "1");
    return true;
  })()`);
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "OpenWork control API" });
  const workspaceId = await ctx.eval(`(() => {
    const route = window.__openworkControl?.snapshot?.().route ?? location.hash;
    return (String(route).match(/\\/workspace\\/([^/]+)/) ?? [])[1]
      ?? localStorage.getItem("openwork.react.activeWorkspace")
      ?? "";
  })()`);
  await ctx.navigateHash(workspaceId
    ? `/workspace/${workspaceId}/settings/debug`
    : "/settings/debug");
  await ctx.waitFor("location.hash.includes('/settings/debug')", { timeoutMs: 30_000, label: "Settings Debug route" });
  await ctx.waitFor(`(() => {
    const button = document.querySelector(${JSON.stringify(RUN_BUTTON)});
    return Boolean(button) && !button.disabled;
  })()`, { timeoutMs: 45_000, label: "Run agent diagnostics button" });
}

async function navigateToConnect(ctx) {
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "OpenWork control API" });
  const workspaceId = await ctx.eval(`(() => {
    const route = window.__openworkControl?.snapshot?.().route ?? location.hash;
    return (String(route).match(/\\/workspace\\/([^/]+)/) ?? [])[1]
      ?? localStorage.getItem("openwork.react.activeWorkspace")
      ?? "";
  })()`);
  await ctx.navigateHash(workspaceId
    ? `/workspace/${workspaceId}/settings/connect`
    : "/settings/connect");
  await ctx.waitFor("location.hash.includes('/settings/connect')", { timeoutMs: 30_000, label: "Settings Connect route" });
  await ctx.waitFor(`document.body.innerText.includes("Connect for teams")`, { timeoutMs: 30_000, label: "Connect header" });
}

async function installForwardingDiagnosticsObserver(ctx) {
  await ctx.eval(`(() => {
    const previous = window.__openworkAgentDiagnosticsEval;
    const originalFetch = previous?.originalFetch ?? window.fetch.bind(window);
    window.__openworkAgentDiagnosticsEval = {
      originalFetch,
      requests: [],
    };
    window.fetch = async (input, init) => {
      const state = window.__openworkAgentDiagnosticsEval;
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input instanceof Request
            ? input.url
            : String(input);
      const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      let body = "";
      if (typeof init?.body === "string") {
        body = init.body;
      } else if (input instanceof Request && method !== "GET" && method !== "HEAD") {
        body = await input.clone().text().catch(() => "<unreadable>");
      }
      let pathname = "";
      try {
        pathname = new URL(url, location.href).pathname;
      } catch {
        pathname = url.split(/[?#]/, 1)[0];
      }
      const diagnostics = method === "POST" && ${DIAGNOSTICS_PATH_RE}.test(pathname);
      const entry = {
        sequence: state.requests.length + 1,
        method,
        pathname,
        body,
        diagnostics,
        forwarded: true,
        responseStatus: null,
        responseBody: "",
      };
      state.requests.push(entry);
      const response = await originalFetch(input, init);
      if (diagnostics) {
        entry.responseStatus = response.status;
        entry.responseBody = await response.clone().text();
      }
      return response;
    };
    return true;
  })()`);
}

async function realClickSelector(ctx, selector, label) {
  const point = await ctx.waitFor(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element || element.disabled) return false;
    element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`, { timeoutMs: 20_000, label });

  if (!ctx.client?.send) {
    await ctx.eval(`document.querySelector(${JSON.stringify(selector)})?.click(); true`);
    return;
  }
  await ctx.eval(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    window.__openworkFraimzClickObserved = false;
    element?.addEventListener("click", () => { window.__openworkFraimzClickObserved = true; }, { once: true });
    return Boolean(element);
  })()`);
  await ctx.client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await ctx.client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  await ctx.client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const observed = await ctx.eval("window.__openworkFraimzClickObserved === true");
  if (!observed) {
    ctx.log(`CDP mouse input did not reach ${label}; dispatching the element's click handler.`);
    await ctx.eval(`document.querySelector(${JSON.stringify(selector)})?.click(); true`);
  }
}

async function scrollIntoView(ctx, selector, block = "center") {
  const found = await ctx.eval(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    element?.scrollIntoView({ block: ${JSON.stringify(block)}, inline: "nearest", behavior: "instant" });
    return Boolean(element);
  })()`);
  ctx.assert(found === true, `Screenshot target was not found: ${selector}`);
}

async function observerLog(ctx) {
  return ctx.eval(`(() => ({
    entries: (window.__openworkAgentDiagnosticsEval?.requests ?? []).map((entry) => ({ ...entry })),
  }))()`);
}

function actualDiagnosticsExchange(log) {
  const exchanges = log.entries.filter((entry) => entry.diagnostics);
  if (exchanges.length !== 1) {
    throw new Error(`Expected exactly one forwarded diagnostics request, observed ${exchanges.length}: ${JSON.stringify(log.entries)}`);
  }
  const exchange = exchanges[0];
  return {
    exchange,
    request: JSON.parse(exchange.body),
    report: JSON.parse(exchange.responseBody),
  };
}

async function grantClipboardPermissions(ctx) {
  if (!ctx.client?.send) return;
  const origin = await ctx.eval("location.origin");
  await ctx.client.send("Browser.grantPermissions", {
    origin,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });
}

function collectObjectKeys(value, keys = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectObjectKeys(item, keys);
    return keys;
  }
  if (!value || typeof value !== "object") return keys;
  for (const [key, child] of Object.entries(value)) {
    keys.push(key);
    collectObjectKeys(child, keys);
  }
  return keys;
}

function collectStringValues(value, strings = []) {
  if (typeof value === "string") {
    strings.push(value);
    return strings;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, strings);
    return strings;
  }
  if (!value || typeof value !== "object") return strings;
  for (const child of Object.values(value)) collectStringValues(child, strings);
  return strings;
}

export default {
  id: FLOW_ID,
  title: "Settings Debug audits effective agent and MCP injection with a reality-backed bounded diagnostics report",
  kind: "user-facing",
  spec: "evals/voiceovers/connect-agent-diagnostics.md",
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("Run agent diagnostics forwards one real bounded server request without direct mutation calls", {
          voiceover: vo[0],
          action: async () => {
            await setDesktopViewport(ctx);
            await navigateToDebugDiagnostics(ctx);
            await installForwardingDiagnosticsObserver(ctx);
            await realClickSelector(ctx, RUN_BUTTON, "Run agent diagnostics");
            await ctx.waitFor(`Boolean(document.querySelector(${JSON.stringify(REPORT)}))`, {
              timeoutMs: 30_000,
              label: "real agent diagnostics report",
            });
            await scrollIntoView(ctx, REPORT, "start");
          },
          assert: async () => {
            const log = await observerLog(ctx);
            const { exchange, request, report } = actualDiagnosticsExchange(log);
            const prohibitedMutations = log.entries.filter((entry) => {
              if (entry.diagnostics) return false;
              const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(entry.method);
              return mutating && /(refresh|reload|reconnect|\/opencode-config(?:\/|$)|\/config(?:\/|$)|\/mcp(?:\/|$)|\/connect\/state(?:\/|$))/i.test(entry.pathname);
            });
            ctx.assert(exchange.forwarded === true, "The diagnostics request was not forwarded to the real OpenWork server.");
            ctx.assert(exchange.responseStatus === 200, `The real diagnostics route returned ${exchange.responseStatus}.`);
            ctx.assert(
              Object.keys(request).sort().join(",") === "organizationConnections,organizationConnectionsProbe",
              `Diagnostics sent unexpected request fields: ${JSON.stringify(request)}`,
            );
            ctx.assert(prohibitedMutations.length === 0, `Diagnostics triggered a prohibited mutation: ${JSON.stringify(prohibitedMutations)}`);
            ctx.assert(report.schemaVersion === 1 && typeof report.runId === "string", "The server response was not a versioned diagnostics report.");
            ctx.assert(
              JSON.stringify(report.checks.map((check) => check.id)) === JSON.stringify(CHECK_IDS),
              `The real report did not contain the canonical checks: ${JSON.stringify(report.checks)}`,
            );
            await ctx.expectHashIncludes("/settings/debug");
            ctx.output("agent-diagnostics-real-exchange", JSON.stringify({
              request: { method: exchange.method, pathname: exchange.pathname, body: request },
              responseStatus: exchange.responseStatus,
              report,
            }, null, 2));
          },
          screenshot: {
            name: "agent-diagnostics-real-bounded-run",
            claim: "Settings Debug displays the report returned by the real OpenWork diagnostics route.",
            requireText: ["Agent diagnostics report", "Diagnostics directly requests no configuration mutation"],
            rejectText: ["Agent diagnostics could not complete", "Something went wrong"],
            hashIncludes: "/settings/debug",
          },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("The real report distinguishes effective engine evidence from configured fallback intent", {
          voiceover: vo[1],
          action: async () => {
            await scrollIntoView(ctx, '[data-testid="agent-diagnostics-plugin-label"]', "center");
          },
          assert: async () => {
            const { report } = actualDiagnosticsExchange(await observerLog(ctx));
            const engineReadChecks = ENGINE_READ_CHECKS.map((id) => report.checks.find((check) => check.id === id));
            const effective = report.agent.evidenceSource === "effective-engine";
            ctx.assert(report.agent.configuredOpenworkAgent.state === "present", "The reported OpenWork agent was absent or disabled.");
            ctx.assert(report.agent.configuredOpenworkAgent.mode === "primary", `Unexpected agent mode: ${report.agent.configuredOpenworkAgent.mode}`);
            ctx.assert(
              Object.values(report.agent.configuredOpenworkAgent.prompt.markers).every(Boolean),
              `Required context markers were absent: ${JSON.stringify(report.agent.configuredOpenworkAgent.prompt.markers)}`,
            );
            ctx.assert(
              report.agent.pluginLabels.includes("openwork-extensions-preview"),
              `Connect steering plugin evidence was absent: ${JSON.stringify(report.agent.pluginLabels)}`,
            );
            if (effective) {
              ctx.assert(report.safety.engineApiReadPerformed === true, "Effective evidence did not record the engine reads.");
              ctx.assert(
                engineReadChecks.every((check) => check?.evidenceKind === "observed" && ["passed", "failed"].includes(check.status)),
                `Effective engine checks were not observed: ${JSON.stringify(engineReadChecks)}`,
              );
              const engineConfigMcps = report.mcps.filter((mcp) => mcp.source === "engine.config");
              const runtimeManagedMcps = report.mcps.filter((mcp) => mcp.source === "config.remote");
              const inventoryCheck = report.checks.find((check) => check.id === "mcp-inventory");
              const engineConfigMcpCount = inventoryCheck?.details?.engineConfigMcpCount;
              const runtimeManagedMcpCount = inventoryCheck?.details?.runtimeManagedMcpCount;
              ctx.assert(
                Number.isInteger(engineConfigMcpCount) && engineConfigMcpCount >= engineConfigMcps.length,
                `Engine merged MCP count contradicted its bounded rows: ${JSON.stringify({ engineConfigMcpCount, engineConfigMcps })}`,
              );
              ctx.assert(
                Number.isInteger(runtimeManagedMcpCount) && runtimeManagedMcpCount >= runtimeManagedMcps.length,
                `Runtime-managed MCP count contradicted its bounded rows: ${JSON.stringify({ runtimeManagedMcpCount, runtimeManagedMcps })}`,
              );
              if (engineConfigMcpCount === 0) {
                ctx.assert(engineConfigMcps.length === 0, `An empty effective MCP configuration synthesized rows: ${JSON.stringify(engineConfigMcps)}`);
              }
              if (runtimeManagedMcpCount === 0) {
                ctx.assert(runtimeManagedMcps.length === 0, `An empty runtime-managed MCP configuration synthesized rows: ${JSON.stringify(runtimeManagedMcps)}`);
              }
              ctx.assert(
                runtimeManagedMcps.every((mcp) => ["connected", "disabled", "failed", "needs-auth", "needs-client-registration", "not-recorded"].includes(mcp.syncStatus)),
                `Runtime-managed MCP rows lacked registration evidence: ${JSON.stringify(runtimeManagedMcps)}`,
              );
            } else {
              ctx.assert(
                engineReadChecks.every((check) => check?.status === "warning" && check?.evidenceKind === "unavailable"),
                `Fallback engine checks overstated their evidence: ${JSON.stringify(engineReadChecks)}`,
              );
            }
            const rendered = await ctx.eval(`(() => {
              const text = (element) => (element?.textContent ?? "").replace(/\\s+/g, " ").trim();
              return {
                report: text(document.querySelector(${JSON.stringify(REPORT)})),
                plugins: [...document.querySelectorAll('[data-testid="agent-diagnostics-plugin-label"]')].map(text),
                mcps: [...document.querySelectorAll('[data-testid="agent-diagnostics-mcp-row"]')].map((row) => row.getAttribute("data-mcp-name")),
              };
            })()`);
            ctx.assert(
              rendered.report.includes(effective ? "Effective OpenWork agent" : "Configured OpenWork agent"),
              "The report did not label the agent evidence scope.",
            );
            for (const marker of ["search_capabilities", "execute_capability", "Memory marker"]) {
              ctx.assert(rendered.report.includes(marker), `Rendered marker was missing: ${marker}`);
            }
            ctx.assert(rendered.plugins.includes("openwork-extensions-preview"), "Connect plugin evidence was not rendered.");
            ctx.assert(
              JSON.stringify(rendered.mcps.sort()) === JSON.stringify(report.mcps.map((mcp) => mcp.name).sort()),
              `Rendered MCP rows diverged from the real report: ${JSON.stringify(rendered.mcps)} vs ${JSON.stringify(report.mcps)}`,
            );
            if (report.mcps.length === 0) {
              ctx.assert(
                rendered.report.includes("No MCP configuration entries were observed."),
                "The real empty MCP inventory was not visibly reported.",
              );
            }
          },
          screenshot: {
            name: "agent-diagnostics-real-injection-intent",
            claim: "Agent markers, plugin labels, and the real MCP inventory state are visibly labeled as effective engine evidence or configured fallback intent.",
            requireText: ["OpenWork agent", "search_capabilities", "execute_capability", "openwork-extensions-preview", "MCP inventory"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("Cloud and organization evidence exactly mirror the real active-or-fail-closed response", {
          voiceover: vo[2],
          action: async () => {
            await scrollIntoView(ctx, '[data-testid="agent-diagnostics-cloud-endpoint"]', "start");
          },
          assert: async () => {
            const { request, report } = actualDiagnosticsExchange(await observerLog(ctx));
            const cloudCheck = report.checks.find((check) => check.id === "cloud-tool-catalog");
            ctx.assert(cloudCheck, "The cloud catalog check was absent.");
            const performed = report.safety.cloudCatalogToolsListPerformed;
            ctx.assert(cloudCheck.details.requestPerformed === performed, `Cloud check contradicted safety metadata: ${JSON.stringify(cloudCheck)}`);
            if (performed && cloudCheck.code === "cloud_catalog_exact_match") {
              const runtimeCloud = report.mcps.find((mcp) => mcp.source === "config.remote" && mcp.name === "openwork-cloud");
              ctx.assert(runtimeCloud?.syncStatus === "connected", `Cloud catalog ran without connected runtime registration evidence: ${JSON.stringify(runtimeCloud)}`);
              ctx.assert(
                JSON.stringify([...report.observedCloudToolIds].sort()) === JSON.stringify(["execute_capability", "search_capabilities"]),
                `Observed cloud catalog drifted: ${JSON.stringify(report.observedCloudToolIds)}`,
              );
            } else if (!performed) {
              ctx.assert(report.observedCloudToolIds.length === 0, `A skipped catalog claimed observed tools: ${JSON.stringify(report.observedCloudToolIds)}`);
            }
            ctx.assert(
              JSON.stringify(report.organizationConnectionsProbe) === JSON.stringify(request.organizationConnectionsProbe),
              `Organization probe evidence did not mirror the client observation: ${JSON.stringify({ request, report })}`,
            );
            ctx.assert(
              report.organizationConnections.length === request.organizationConnections.length,
              `Organization rows were synthesized or dropped: ${JSON.stringify({ request: request.organizationConnections, response: report.organizationConnections })}`,
            );
            const rendered = await ctx.eval(`(() => {
              const text = (element) => (element?.textContent ?? "").replace(/\\s+/g, " ").trim();
              return {
                expectedEndpoint: text(document.querySelector('[data-testid="agent-diagnostics-cloud-endpoint-expected"]')),
                endpoint: text(document.querySelector('[data-testid="agent-diagnostics-cloud-endpoint"]')),
                report: text(document.querySelector(${JSON.stringify(REPORT)})),
                orgRows: [...document.querySelectorAll('[data-testid="agent-diagnostics-org-connection"]')].map(text),
                mcpRows: [...document.querySelectorAll('[data-testid="agent-diagnostics-mcp-row"]')].map(text),
              };
            })()`);
            ctx.assert(rendered.expectedEndpoint === "/mcp/agent", `Required terminal path drifted: ${rendered.expectedEndpoint}`);
            ctx.assert(rendered.report.includes("search_capabilities, execute_capability"), "Expected cloud tool contract was not rendered.");
            if (!performed) {
              ctx.assert(rendered.report.includes("The live cloud catalog was not observed."), "Fail-closed catalog status was not visible.");
            } else {
              ctx.assert(rendered.report.includes("Cloud tools/list performed: Yes"), "The performed catalog request was not visible.");
            }
            ctx.assert(rendered.orgRows.length === report.organizationConnections.length, "Rendered organization rows diverged from the real response.");
            for (const connection of report.organizationConnections) {
              ctx.assert(!rendered.mcpRows.some((row) => row.includes(connection.name)), `Organization connection leaked into MCP rows: ${connection.name}`);
            }
          },
          screenshot: {
            name: "agent-diagnostics-real-cloud-and-org",
            claim: "The report shows the cloud contract and its real observed-or-skipped result while keeping client-observed organization readiness separate.",
            requireText: ["/mcp/agent", "search_capabilities, execute_capability", "Organization connections"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        let copiedText = "";
        await ctx.prove("Copy report exports the exact sanitized server response with actionable ownership", {
          voiceover: vo[3],
          action: async () => {
            await grantClipboardPermissions(ctx);
            await scrollIntoView(ctx, COPY_BUTTON, "center");
            await realClickSelector(ctx, COPY_BUTTON, "Copy sanitized diagnostics report");
            await ctx.waitFor(`document.querySelector(${JSON.stringify(COPY_BUTTON)})?.textContent?.includes("Copied")`, {
              timeoutMs: 15_000,
              label: "sanitized real report copied",
            });
            copiedText = await ctx.eval("navigator.clipboard.readText()", { awaitPromise: true });
            await scrollIntoView(ctx, CLOUD_CHECK, "center");
          },
          assert: async () => {
            const { report } = actualDiagnosticsExchange(await observerLog(ctx));
            const copied = JSON.parse(copiedText);
            ctx.assert(JSON.stringify(copied) === JSON.stringify(report), "Copied JSON did not match the real sanitized server response.");
            const keys = collectObjectKeys(copied);
            for (const forbiddenKey of ["headers", "authorization", "token", "url", "rawPrompt", "providerResponse", "stackTrace"]) {
              ctx.assert(!keys.includes(forbiddenKey), `Copied report contained forbidden key ${forbiddenKey}.`);
            }
            for (const value of collectStringValues(copied)) {
              ctx.assert(!/\b(?:Bearer|Basic)\s+/iu.test(value), `Copied report included an authorization-shaped value: ${value}`);
              ctx.assert(!/\b[a-z][a-z0-9+.-]*:\/\//iu.test(value), `Copied report included a full URL: ${value}`);
              const withoutAllowedMcpPath = value.replaceAll("/mcp/agent", "");
              ctx.assert(
                !/(?:^|[\s("'=,:])(?:~[\\/]|[A-Za-z]:[\\/]|\\\\|\/)/mu.test(withoutAllowedMcpPath),
                `Copied report included an absolute path other than /mcp/agent: ${value}`,
              );
            }
            ctx.assert(copied.safety.tokenValuesIncluded === false, "Copied report claimed token values were included.");
            ctx.assert(copied.safety.authorizationHeaderValuesIncluded === false, "Copied report claimed authorization values were included.");
            ctx.assert(copied.safety.credentialValuesIncluded === false, "Copied report claimed credential values were included.");
            ctx.assert(copied.safety.rawPromptsIncluded === false, "Copied report claimed raw prompts were included.");
            ctx.assert(copied.safety.providerResponsesIncluded === false, "Copied report claimed provider responses were included.");
            ctx.assert(copied.safety.stackTracesIncluded === false, "Copied report claimed stack traces were included.");
            ctx.assert(copied.safety.secretBearingUrlsIncluded === false, "Copied report claimed secret URLs were included.");
            const cloudCheck = copied.checks.find((check) => check.id === "cloud-tool-catalog");
            ctx.assert(typeof cloudCheck?.owner === "string" && cloudCheck.owner.length > 0, "Cloud check did not identify an owner.");
            ctx.assert(typeof cloudCheck?.action === "string" && cloudCheck.action.length > 0, "Cloud check did not provide a recommended action.");
            const rendered = await ctx.eval(`(() => {
              const text = (element) => (element?.textContent ?? "").replace(/\\s+/g, " ").trim();
              const check = document.querySelector(${JSON.stringify(CLOUD_CHECK)});
              return {
                owner: text(check?.querySelector('[data-testid="agent-diagnostics-check-owner"]')),
                action: text(check?.querySelector('[data-testid="agent-diagnostics-check-action"]')),
              };
            })()`);
            ctx.assert(rendered.owner.startsWith("Owner: "), `Cloud owner was not rendered: ${rendered.owner}`);
            ctx.assert(rendered.action.startsWith("Recommended action: "), `Cloud action was not rendered: ${rendered.action}`);
            ctx.output("agent-diagnostics-real-copy", JSON.stringify({
              runId: copied.runId,
              firstFailedCheck: copied.firstFailedCheck,
              cloudCode: cloudCheck.code,
              cloudOwner: cloudCheck.owner,
              cloudAction: cloudCheck.action,
              serializedBytes: copiedText.length,
            }, null, 2));
          },
          screenshot: {
            name: "agent-diagnostics-real-action-and-copy",
            claim: "The real cloud check names an owner and recovery action, and the exact sanitized response is copyable.",
            requireText: ["OpenWork Cloud tool catalog", "Owner", "Recommended action"],
            rejectText: ["Bearer ", "https://", "Error:"],
          },
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await ctx.prove("Connect no longer hosts the agent diagnostics launcher", {
          voiceover: vo[4],
          action: async () => {
            await navigateToConnect(ctx);
          },
          assert: async () => {
            const rendered = await ctx.eval(`(() => ({
              buttonPresent: Boolean(document.querySelector(${JSON.stringify(RUN_BUTTON)})),
              bodyText: document.body.innerText,
            }))()`);
            ctx.assert(rendered.buttonPresent === false, "The Run agent diagnostics button is still present on Connect.");
            ctx.assert(!rendered.bodyText.includes("Run agent diagnostics"), "Connect still contains the diagnostics run label.");
          },
          screenshot: {
            name: "connect-without-diagnostics",
            claim: "The Connect tab no longer hosts agent diagnostics; the Run button is absent.",
            requireText: ["Connect for teams"],
            rejectText: ["Run agent diagnostics"],
            hashIncludes: "/settings/connect",
          },
        });
      },
    },
  ],
};
