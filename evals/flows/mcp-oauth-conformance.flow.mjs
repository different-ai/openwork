import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import {
  denApiFetch,
  denWebUrl,
  mcpAgentCall,
  mintMcpToken,
  openAdminConnections,
  signInApi,
  signInViaBrowser,
} from "./lib/den-web.mjs";

const FLOW_ID = "mcp-oauth-conformance";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const vo = await loadVoiceoverParagraphs(FLOW_ID);
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const MOCK_PORT = Number(process.env.OPENWORK_EVAL_MCP_OAUTH_PORT ?? 39728);
const MOCK_ORIGIN = `http://127.0.0.1:${MOCK_PORT}`;
const RUN_TAG = Date.now().toString(36);
const CONNECTION_PREFIX = "OAuth conformance";
const CONNECTION_NAME = `${CONNECTION_PREFIX} ${RUN_TAG}`;
const SHARED_CALLBACK_PATH = "/v1/mcp-connections/oauth/callback";
const ECHO_TEXT = "shared callback end-to-end proof";

const state = {
  adminToken: null,
  connectionId: null,
  mockChild: null,
  mockExitHandler: null,
  mockOutput: "",
  organizationId: null,
};

function requireState(value, label) {
  if (typeof value === "string" && value.trim()) return value;
  throw new Error(`${label} was not prepared.`);
}

function authHeaders() {
  return {
    authorization: `Bearer ${requireState(state.adminToken, "admin token")}`,
    "x-openwork-org-id": requireState(state.organizationId, "organization id"),
  };
}

async function orgApi(ctx, pathname, init = {}) {
  const result = await denApiFetch(pathname, {
    ...init,
    headers: { ...authHeaders(), ...(init.headers ?? {}) },
  });
  ctx.assert(result.response.ok, `${pathname} failed: ${result.response.status} ${JSON.stringify(result.body).slice(0, 500)}`);
  return result.body;
}

async function manageableConnections(ctx) {
  const result = await orgApi(ctx, "/v1/mcp-connections?scope=manageable");
  return Array.isArray(result.connections) ? result.connections : [];
}

async function mockRequests(ctx) {
  const response = await fetch(`${MOCK_ORIGIN}/requests`, { signal: AbortSignal.timeout(3_000) });
  ctx.assert(response.ok, `Mock request log failed: ${response.status}`);
  const body = await response.json();
  return Array.isArray(body.requests) ? body.requests : [];
}

function stopMock() {
  const child = state.mockChild;
  if (!child) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    // The child may already have exited.
  }
  if (state.mockExitHandler) process.removeListener("exit", state.mockExitHandler);
  state.mockChild = null;
  state.mockExitHandler = null;
}

async function startMock(ctx) {
  state.mockChild = spawn(process.execPath, [join(ROOT, "scripts", "mock-oauth-mcp-server.mjs")], {
    cwd: ROOT,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      AUTO_APPROVE: "1",
      HOST: "127.0.0.1",
      ISSUER: MOCK_ORIGIN,
      PORT: String(MOCK_PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const remember = (chunk) => {
    state.mockOutput = `${state.mockOutput}${String(chunk)}`.slice(-8_000);
  };
  state.mockChild.stdout?.on("data", remember);
  state.mockChild.stderr?.on("data", remember);
  state.mockExitHandler = () => stopMock();
  process.once("exit", state.mockExitHandler);

  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    try {
      const response = await fetch(`${MOCK_ORIGIN}/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // Keep polling until the bounded startup deadline.
    }
    if (state.mockChild.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  ctx.assert(false, `Mock OAuth MCP server did not start. ${state.mockOutput.slice(-1_000)}`);
}

async function prepareAdmin(ctx) {
  state.adminToken = await signInApi(ADMIN_EMAIL, ADMIN_PASSWORD);
  ctx.assert(Boolean(state.adminToken), `Den API sign-in failed for ${ADMIN_EMAIL}.`);
  const orgsResult = await denApiFetch("/v1/me/orgs", {
    headers: { authorization: `Bearer ${state.adminToken}` },
  });
  ctx.assert(orgsResult.response.ok, `Listing organizations failed: ${orgsResult.response.status}`);
  const orgs = Array.isArray(orgsResult.body?.orgs) ? orgsResult.body.orgs : [];
  const organization = orgs.find((entry) => String(entry.name ?? "").includes("Acme Robotics"))
    ?? orgs.find((entry) => ["owner", "admin"].includes(String(entry.role ?? "").toLowerCase()))
    ?? orgs[0];
  ctx.assert(organization && typeof organization.id === "string", "No administrator organization was available.");
  state.organizationId = organization.id;

  for (const connection of await manageableConnections(ctx)) {
    if (!String(connection.name ?? "").startsWith(CONNECTION_PREFIX)) continue;
    const removed = await denApiFetch(`/v1/mcp-connections/${connection.id}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    ctx.assert(removed.response.ok || removed.response.status === 404, `Cleanup failed for ${connection.id}.`);
  }
}

async function openConnectionsScreen(ctx) {
  await ctx.client.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const currentUrl = await ctx.eval("window.location.href");
  if (!currentUrl.includes(new URL(denWebUrl()).host)) {
    await ctx.eval(`(() => { window.location.href = ${JSON.stringify(denWebUrl())}; return true; })()`);
    await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: "Den web loaded" });
  }
  const signedInAsAdmin = (await ctx.hasText("Dashboard"))
    && await ctx.eval("Boolean([...document.querySelectorAll('a')].find((entry) => entry.getAttribute('href')?.includes('mcp-connections')))");
  if (!signedInAsAdmin) await signInViaBrowser(ctx, ADMIN_EMAIL, ADMIN_PASSWORD);
  await openAdminConnections(ctx);
  await ctx.expectText("Add a connection", { timeoutMs: 30_000 });
}

async function findConnection(ctx) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    const connection = (await manageableConnections(ctx)).find((entry) => entry.name === CONNECTION_NAME);
    if (connection) return connection;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  ctx.assert(false, `${CONNECTION_NAME} was not returned by the normalized API.`);
}

export default {
  id: FLOW_ID,
  title: "URL discovery, shared callback OAuth, and MCP tool use succeed end to end",
  kind: "user-facing",
  spec: "docs/external-mcp-oauth.md",
  preserveTheme: true,
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "Prepare the isolated Den and OAuth MCP server",
      run: async (ctx) => {
        await startMock(ctx);
        await prepareAdmin(ctx);
        await openConnectionsScreen(ctx);
      },
    },
    {
      name: "Requirements discovery is visible and side-effect free",
      run: async (ctx) => {
        const connectionCountBefore = (await manageableConnections(ctx)).length;
        const registrationsBefore = (await mockRequests(ctx)).filter((entry) => entry.path === "/register").length;
        await ctx.prove("URL-only discovery explains OAuth requirements without saving or registering anything", {
          voiceover: vo[0],
          action: async () => {
            await ctx.clickText("MCP server", { selector: "button", timeoutMs: 20_000 });
            await ctx.waitForText("Add a custom MCP server", { timeoutMs: 10_000 });
            await ctx.client.send("Emulation.setDeviceMetricsOverride", {
              width: 1440,
              height: 600,
              deviceScaleFactor: 1,
              mobile: false,
            });
            const viewportSafety = await ctx.eval(`(() => {
              const dialog = document.querySelector('[data-testid="add-mcp-connection-dialog"]');
              if (!(dialog instanceof HTMLElement)) return null;
              const style = getComputedStyle(dialog);
              const dialogRect = dialog.getBoundingClientRect();
              const action = [...dialog.querySelectorAll('button')].find((entry) => (entry.textContent ?? '').trim() === 'Add connection');
              dialog.scrollTop = dialog.scrollHeight;
              const actionRect = action?.getBoundingClientRect();
              const actionReachable = Boolean(actionRect
                && actionRect.top >= dialogRect.top
                && actionRect.bottom <= dialogRect.bottom
                && actionRect.bottom <= window.innerHeight);
              const result = {
                actionReachable,
                clientHeight: dialog.clientHeight,
                dialogBottom: Math.round(dialogRect.bottom),
                dialogTop: Math.round(dialogRect.top),
                overflowY: style.overflowY,
                scrollHeight: dialog.scrollHeight,
                viewportHeight: window.innerHeight,
              };
              dialog.scrollTop = 0;
              return result;
            })()`);
            ctx.assert(viewportSafety, "The add-connection dialog was not rendered.");
            ctx.assert(viewportSafety.scrollHeight > viewportSafety.clientHeight, "The long dialog did not become internally scrollable.");
            ctx.assert(["auto", "scroll"].includes(viewportSafety.overflowY), `Dialog overflow was ${viewportSafety.overflowY}.`);
            ctx.assert(viewportSafety.dialogTop >= 0 && viewportSafety.dialogBottom <= viewportSafety.viewportHeight, "The dialog was clipped by the viewport.");
            ctx.assert(viewportSafety.actionReachable, "The final Add connection action could not be reached by scrolling.");
            ctx.output("Short-viewport dialog safety", JSON.stringify(viewportSafety, null, 2));
            await ctx.client.send("Emulation.setDeviceMetricsOverride", {
              width: 1440,
              height: 1100,
              deviceScaleFactor: 1,
              mobile: false,
            });
            await ctx.fill('input[placeholder="notion"]', CONNECTION_NAME);
            await ctx.fill('input[placeholder="https://mcp.example.com/mcp"]', `${MOCK_ORIGIN}/mcp`);
            await ctx.clickText("Discover requirements", { selector: "button", timeoutMs: 15_000 });
            await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"mcp-requirements-result\"]'))", {
              timeoutMs: 30_000,
              label: "requirements result",
            });
          },
          assert: async () => {
            await ctx.expectText("OAuth authentication is required.");
            await ctx.expectText("Registration: dynamic registration.");
            await ctx.expectText("Administrator action required");
            await ctx.expectText("mcp:read");
            const connectionCountAfter = (await manageableConnections(ctx)).length;
            const registrationsAfter = (await mockRequests(ctx)).filter((entry) => entry.path === "/register").length;
            ctx.assert(connectionCountAfter === connectionCountBefore, "Requirements discovery created a connection row.");
            ctx.assert(registrationsAfter === registrationsBefore, "Requirements discovery performed dynamic client registration.");
            ctx.output("Side-effect-free discovery", JSON.stringify({
              connectionCountBefore,
              connectionCountAfter,
              dynamicRegistrationsBefore: registrationsBefore,
              dynamicRegistrationsAfter: registrationsAfter,
            }, null, 2));
          },
          screenshot: {
            name: "requirements-discovered",
            requireText: [
              "Detected automatically",
              "OAuth authentication is required.",
              "Registration: dynamic registration.",
              "Administrator action required",
              "Permissions",
            ],
            rejectText: ["Requirements discovery failed", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "DCR and PKCE return through the shared callback",
      run: async (ctx) => {
        await ctx.prove("Dynamic registration identifies OpenWork as a web client and completes through one shared callback", {
          voiceover: vo[1],
          action: async () => {
            const selected = await ctx.eval(`(() => {
              const labels = [...document.querySelectorAll('label')];
              const label = labels.find((entry) => (entry.textContent ?? '').includes('mcp:read'));
              const input = label?.querySelector('input[type="checkbox"]');
              if (input && !input.checked) input.click();
              const orgButton = [...document.querySelectorAll('button')].find((entry) => (entry.textContent ?? '').trim() === 'One org account');
              orgButton?.click();
              return Boolean(input?.checked && orgButton);
            })()`);
            ctx.assert(selected, "Could not select the read scope and organization account mode.");
            await ctx.switchToNewTab({
              timeoutMs: 20_000,
              label: "OAuth authorization window",
              trigger: () => ctx.clickText("Add connection", { selector: "button", timeoutMs: 15_000 }),
            });
            await ctx.waitForText("Connected", { timeoutMs: 30_000 });
            await ctx.client.send("Emulation.setDeviceMetricsOverride", {
              width: 900,
              height: 500,
              deviceScaleFactor: 1,
              mobile: false,
            });
          },
          assert: async () => {
            await ctx.expectText(CONNECTION_NAME);
            await ctx.expectNoText("Connection failed");
            const connection = await findConnection(ctx);
            state.connectionId = connection.id;
            const requests = await mockRequests(ctx);
            const registration = [...requests].reverse().find((entry) => entry.path === "/register")?.registration;
            ctx.assert(registration?.application_type === "web", `DCR application_type was ${registration?.application_type}.`);
            ctx.assert(Array.isArray(registration?.redirect_uris) && registration.redirect_uris.length === 1, "DCR did not send exactly one callback.");
            ctx.assert(registration.redirect_uris[0] === connection.oauthSharedCallbackUrl, "DCR callback did not equal Den's shared callback.");
            ctx.assert(registration.redirect_uris[0].endsWith(SHARED_CALLBACK_PATH), "DCR did not use the shared callback path.");
            ctx.assert(!registration.redirect_uris[0].includes(connection.id), "DCR callback exposed the connection id.");
            ctx.assert(registration.scope === "mcp:read", `DCR scope was ${registration.scope}, expected mcp:read.`);
            ctx.output("DCR contract", JSON.stringify({
              applicationType: registration.application_type,
              redirectUris: registration.redirect_uris,
              scope: registration.scope,
            }, null, 2));
          },
          screenshot: {
            name: "shared-callback-connected",
            requireText: ["Connected", CONNECTION_NAME],
            rejectText: ["Connection failed", "Invalid or expired state"],
          },
        });
      },
    },
    {
      name: "The normalized connection contract reports the shared callback",
      run: async (ctx) => {
        await ctx.prove("The dashboard reports a connected dynamic client on the deployment-wide callback", {
          voiceover: vo[2],
          action: async () => {
            await ctx.switchBack();
            await ctx.client.send("Emulation.setDeviceMetricsOverride", {
              width: 1440,
              height: 500,
              deviceScaleFactor: 1,
              mobile: false,
            });
            await ctx.waitFor(`(() => {
              const nodes = [...document.querySelectorAll('*')].filter((entry) => entry.children.length === 0 && (entry.textContent ?? '').trim() === ${JSON.stringify(CONNECTION_NAME)});
              return nodes.some((node) => {
                let current = node;
                for (let depth = 0; depth < 8 && current; depth += 1) {
                  if ((current.textContent ?? '').includes('Connected') && (current.textContent ?? '').includes('Shared callback')) return true;
                  current = current.parentElement;
                }
                return false;
              });
            })()`, { timeoutMs: 60_000, label: "connected shared callback row" });
            await ctx.eval(`(() => {
              const node = [...document.querySelectorAll('*')].find((entry) => entry.children.length === 0 && (entry.textContent ?? '').trim() === ${JSON.stringify(CONNECTION_NAME)});
              node?.scrollIntoView({ block: 'center' });
              return Boolean(node);
            })()`);
          },
          assert: async () => {
            const connection = await findConnection(ctx);
            ctx.assert(connection.id === state.connectionId, "The connection identity changed after callback completion.");
            ctx.assert(connection.connected === true, "The normalized contract did not report connected.");
            ctx.assert(connection.oauthCallbackMode === "shared-v1", `Callback mode was ${connection.oauthCallbackMode}.`);
            ctx.assert(connection.oauthRegistrationSource === "dynamic", `Registration source was ${connection.oauthRegistrationSource}.`);
            ctx.assert(connection.oauthCallbackUrl === connection.oauthSharedCallbackUrl, "Current and shared callback URLs differ.");
            ctx.assert(connection.oauthCallbackUrl.endsWith(SHARED_CALLBACK_PATH), "Normalized callback does not use the shared path.");
            ctx.assert(!connection.oauthCallbackUrl.includes(connection.id), "Normalized callback exposed the connection id.");
            ctx.assert(connection.requestedScopes?.includes("mcp:read"), "Requested read scope was not persisted.");
            ctx.assert(connection.grantedScopes?.includes("mcp:read"), "Granted read scope was not reported.");
            ctx.assert(!Object.keys(connection).some((key) => /runtime|enterpriseMcpClient/i.test(key)), "The API exposed runtime selection.");
            ctx.output("Normalized connection", JSON.stringify({
              callbackMode: connection.oauthCallbackMode,
              callbackUrl: connection.oauthCallbackUrl,
              connected: connection.connected,
              grantedScopes: connection.grantedScopes,
              registrationSource: connection.oauthRegistrationSource,
              requestedScopes: connection.requestedScopes,
            }, null, 2));
          },
          screenshot: {
            name: "dashboard-shared-callback",
            requireText: [CONNECTION_NAME, "Connected", "Shared callback", "Registration: dynamic", "Current callback:"],
            rejectText: ["Callback update required", "Return to legacy", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "The authorized tool is usable from UI and the agent MCP surface",
      run: async (ctx) => {
        await ctx.prove("The OAuth connection exposes tools to both the dashboard and agent-facing capability surface", {
          voiceover: vo[3],
          action: async () => {
            await ctx.client.send("Emulation.setDeviceMetricsOverride", {
              width: 1440,
              height: 760,
              deviceScaleFactor: 1,
              mobile: false,
            });
            const opened = await ctx.eval(`(() => {
              const name = [...document.querySelectorAll('*')].find((entry) => entry.children.length === 0 && (entry.textContent ?? '').trim() === ${JSON.stringify(CONNECTION_NAME)});
              let row = name;
              for (let depth = 0; depth < 8 && row; depth += 1) {
                const button = [...row.querySelectorAll('button')].find((entry) => (entry.textContent ?? '').trim() === 'View tools');
                if (button) { button.click(); return true; }
                row = row.parentElement;
              }
              return false;
            })()`);
            ctx.assert(opened, "Could not open the connected MCP tool catalog.");
            await ctx.waitForText("Mock Echo", { timeoutMs: 30_000 });
            await ctx.eval(`(() => {
              const node = [...document.querySelectorAll('*')].find((entry) => entry.children.length === 0 && (entry.textContent ?? '').trim() === 'Mock Echo');
              node?.scrollIntoView({ block: 'center' });
              return Boolean(node);
            })()`);
          },
          assert: async () => {
            await ctx.expectText("Tools available to your agents");
            await ctx.expectText("mock_echo");
            const mcpToken = await mintMcpToken(requireState(state.adminToken, "admin token"), ctx);
            const search = await mcpAgentCall(mcpToken, "tools/call", {
              name: "search_capabilities",
              arguments: { query: "mock echo" },
            }, ctx);
            const searchText = search.content?.[0]?.text ?? "";
            const match = JSON.parse(searchText).matches?.find((entry) => String(entry.summary ?? "").includes(CONNECTION_NAME));
            ctx.assert(Boolean(match), `search_capabilities did not return ${CONNECTION_NAME}.`);
            const executed = await mcpAgentCall(mcpToken, "tools/call", {
              name: "execute_capability",
              arguments: { name: match.name, body: { text: ECHO_TEXT } },
            }, ctx);
            ctx.assert(executed.content?.[0]?.text === ECHO_TEXT, "execute_capability did not return the mock echo result.");
            ctx.output("Agent MCP result", JSON.stringify({ match: match.name, result: ECHO_TEXT }, null, 2));
          },
          screenshot: {
            name: "authorized-tool-catalog",
            requireText: ["Tools available to your agents", "Mock Echo", "mock_echo"],
            rejectText: ["Could not read", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Clean up the proof connection and mock server",
      run: async (ctx) => {
        if (state.connectionId) {
          const removed = await denApiFetch(`/v1/mcp-connections/${state.connectionId}`, {
            method: "DELETE",
            headers: authHeaders(),
          });
          ctx.assert(removed.response.ok || removed.response.status === 404, `Cleanup failed: ${removed.response.status}`);
        }
        stopMock();
      },
    },
  ],
};
