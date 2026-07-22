import { execFileSync } from "node:child_process";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import { signInViaBrowser } from "./lib/den-web.mjs";

const FLOW_ID = "den-dashboard-polish";
const vo = await loadVoiceoverParagraphs(FLOW_ID);
const DEN_API_URL = (process.env.OPENWORK_EVAL_DEN_API_URL ?? "").trim().replace(/\/+$/, "");
const DEN_WEB_URL = (process.env.OPENWORK_EVAL_DEN_WEB_URL ?? "").trim().replace(/\/+$/, "");
const OWNER_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const ADMIN_EMAIL = "riley.dashboard-polish@acme.test";
const EXPECTED_VERSION = process.env.OPENWORK_EVAL_DEN_EXPECTED_VERSION?.trim() || "commit 8c412db";

const state = {
  ownerToken: "",
  adminToken: "",
  organizationId: "",
  marketplaceId: "",
  marketplaceName: "",
  iconUrl: "",
};

function witness(ctx, condition, assertion, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual: actual === undefined ? undefined : JSON.stringify(actual).slice(0, 1_200),
  });
  ctx.assert(condition, `${assertion}${actual === undefined ? "" : `. Actual: ${JSON.stringify(actual).slice(0, 600)}`}`);
}

async function denFetch(path, options = {}) {
  const authPath = path.startsWith("/api/auth/");
  const response = await fetch(`${authPath ? DEN_WEB_URL : DEN_API_URL}${path}`, {
    ...options,
    headers: {
      accept: "application/json",
      origin: DEN_WEB_URL,
      ...(options.body instanceof FormData || options.body === undefined ? {} : { "content-type": "application/json" }),
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
  return { response, body };
}

function authHeaders(token) {
  return { authorization: `Bearer ${token}` };
}

async function signInApi(email, password) {
  const result = await denFetch("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  return result.response.ok && typeof result.body?.token === "string" ? result.body.token : "";
}

function runMysql(sql) {
  const container = process.env.OPENWORK_EVAL_DEN_MYSQL_CONTAINER?.trim() || "openwork-web-local-mysql";
  const database = process.env.OPENWORK_EVAL_DEN_DATABASE_NAME?.trim() || "openwork_den";
  execFileSync("docker", [
    "exec",
    container,
    "mysql",
    "-uroot",
    "-ppassword",
    database,
    "-e",
    sql,
  ], { stdio: "ignore" });
}

async function ensureAccount(ctx, { email, name }) {
  let token = await signInApi(email, PASSWORD);
  if (!token) {
    const signUp = await denFetch("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ email, name, password: PASSWORD }),
    });
    witness(ctx, signUp.response.ok || [400, 409, 422].includes(signUp.response.status), `${name}'s account exists or was created`, {
      status: signUp.response.status,
      body: signUp.body,
    });
    runMysql(`UPDATE user SET email_verified = 1 WHERE email = '${email.replaceAll("'", "''")}';`);
    token = await signInApi(email, PASSWORD);
  }
  witness(ctx, token.length > 0, `${name} can sign in through Den`, { email });
  return token;
}

async function ensureSetup(ctx) {
  state.ownerToken = await ensureAccount(ctx, { email: OWNER_EMAIL, name: "Alex Chen" });
  const ownerOrg = await denFetch("/v1/org", { headers: authHeaders(state.ownerToken) });
  witness(ctx, ownerOrg.response.ok && typeof ownerOrg.body?.organization?.id === "string", "The demo owner can load the active workspace", {
    status: ownerOrg.response.status,
    currentMember: ownerOrg.body?.currentMember,
  });
  state.organizationId = ownerOrg.body.organization.id;

  state.adminToken = await ensureAccount(ctx, { email: ADMIN_EMAIL, name: "Riley Admin" });
  let adminOrgs = await denFetch("/v1/me/orgs", { headers: authHeaders(state.adminToken) });
  const alreadyMember = () => Array.isArray(adminOrgs.body?.orgs)
    && adminOrgs.body.orgs.some((entry) => entry?.id === state.organizationId);
  if (!alreadyMember()) {
    const invitation = await denFetch("/v1/invitations", {
      method: "POST",
      headers: authHeaders(state.ownerToken),
      body: JSON.stringify({ email: ADMIN_EMAIL, role: "admin" }),
    });
    witness(ctx, invitation.response.ok && typeof invitation.body?.inviteToken === "string", "The owner can invite the proof account as an admin", {
      status: invitation.response.status,
      body: invitation.body,
    });
    const accepted = await denFetch("/v1/orgs/invitations/accept", {
      method: "POST",
      headers: authHeaders(state.adminToken),
      body: JSON.stringify({ id: invitation.body.inviteToken }),
    });
    witness(ctx, accepted.response.ok && accepted.body?.accepted === true, "The admin accepts the active workspace invitation", {
      status: accepted.response.status,
      body: accepted.body,
    });
    adminOrgs = await denFetch("/v1/me/orgs", { headers: authHeaders(state.adminToken) });
  }
  witness(ctx, alreadyMember(), "The proof account belongs to the active workspace", adminOrgs.body?.orgs);

  const adminOrg = await denFetch("/v1/org", { headers: authHeaders(state.adminToken) });
  witness(
    ctx,
    adminOrg.response.ok && adminOrg.body?.currentMember?.role === "admin" && adminOrg.body?.currentMember?.isOwner === false,
    "The proof user is an admin but not the workspace owner",
    adminOrg.body?.currentMember,
  );

  const marketplaces = await denFetch("/v1/marketplaces?limit=50", { headers: authHeaders(state.adminToken) });
  const preferred = marketplaces.body?.items?.find((item) => item?.name === "Anthropic Knowledge Work Plugins")
    ?? marketplaces.body?.items?.[0];
  witness(ctx, marketplaces.response.ok && typeof preferred?.id === "string", "A real seeded marketplace is available", preferred);
  state.marketplaceId = preferred.id;
  state.marketplaceName = preferred.name;
}

async function navigateTo(ctx, path) {
  const url = new URL(path, DEN_WEB_URL).toString();
  await ctx.eval(`(() => { location.assign(${JSON.stringify(url)}); return true; })()`);
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: `load ${path}` });
}

async function uploadManagedIcon(ctx) {
  const result = await ctx.eval(`new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const context = canvas.getContext('2d');
    context.fillStyle = '#172554';
    context.fillRect(0, 0, 128, 128);
    context.fillStyle = '#dbeafe';
    context.beginPath();
    context.roundRect(24, 24, 80, 80, 20);
    context.fill();
    context.strokeStyle = '#2563eb';
    context.lineWidth = 12;
    context.lineCap = 'round';
    context.beginPath();
    context.moveTo(43, 66);
    context.lineTo(58, 81);
    context.lineTo(88, 46);
    context.stroke();
    canvas.toBlob(async (blob) => {
      if (!blob) return resolve({ status: 0, body: { error: 'canvas_blob_failed' } });
      const form = new FormData();
      form.set('icon', blob, 'den-dashboard-polish-icon.png');
      const response = await fetch('/api/den/v1/org/brand-assets', { method: 'POST', body: form });
      resolve({ status: response.status, body: await response.json() });
    }, 'image/png');
  })`, { awaitPromise: true });
  witness(ctx, result.status === 200, "The owner can upload a square managed icon", result);
  state.iconUrl = result.body?.assets?.icon?.url ?? "";
  witness(ctx, state.iconUrl.length > 0, "The brand upload returns a managed icon URL", result.body?.assets?.icon);
}

function screenshot(name, claim, requireText) {
  return {
    name,
    claim,
    requireText,
    rejectText: ["Something went wrong", "Plugin bundle"],
  };
}

export default {
  id: FLOW_ID,
  title: "Den dashboard polish keeps the admin journey simple and truthful",
  kind: "user-facing",
  preserveTheme: true,
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "Setup",
      run: async (ctx) => {
        await ctx.client.send("Emulation.setDeviceMetricsOverride", {
          width: 1440,
          height: 1000,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await ensureSetup(ctx);
        await signInViaBrowser(ctx, ADMIN_EMAIL, PASSWORD);
        await navigateTo(ctx, "/dashboard");
        await ctx.waitForText("Quick add", { timeoutMs: 30_000 });
      },
    },
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("The admin dashboard exposes Quick add and Extensions defaults to Marketplace", {
          voiceover: vo[0],
          assert: async () => {
            await ctx.expectText("Google Workspace");
            await ctx.expectText("Microsoft 365");
            await ctx.expectText("Telegram");
            const extensionsHref = await ctx.eval(`(() => {
              const link = [...document.querySelectorAll('nav a')]
                .find((entry) => (entry.textContent ?? '').trim().startsWith('Extensions'));
              return link?.getAttribute('href') ?? null;
            })()`);
            witness(ctx, extensionsHref === "/dashboard/marketplaces", "Extensions points to Marketplace first", { extensionsHref });
          },
          screenshot: screenshot(
            "dashboard-quick-add",
            "The admin dashboard visibly offers reusable connector Quick add choices.",
            ["Dashboard", "Quick add", "Google Workspace", "Microsoft 365", "Telegram"],
          ),
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("Marketplace is first in Extensions and offers Add a plugin", {
          voiceover: vo[1],
          action: async () => {
            await navigateTo(ctx, `/dashboard/marketplaces/${encodeURIComponent(state.marketplaceId)}`);
            await ctx.waitForText("Add a plugin", { timeoutMs: 30_000 });
          },
          assert: async () => {
            const nav = await ctx.eval(`(() => [...document.querySelectorAll('nav a')]
              .map((entry) => (entry.textContent ?? '').replace(/\\s+/g, ' ').trim())
              .filter((label) => ['Marketplace', 'Sources', 'Plugins'].includes(label) || label.startsWith('Connectors')))()`);
            witness(
              ctx,
              nav.length >= 4
                && nav[0] === "Marketplace"
                && nav[1] === "Sources"
                && nav[2] === "Plugins"
                && nav[3].startsWith("Connectors")
                && nav[3].includes("Beta"),
              "Extensions is ordered Marketplace, Sources, Plugins, Connectors Beta",
              nav,
            );
          },
          screenshot: screenshot(
            "marketplace-add-plugin",
            "Marketplace is the first Extensions destination and shows Add a plugin.",
            [state.marketplaceName, "Add a plugin", "Marketplace", "Sources", "Plugins", "Connectors", "BETA"],
          ),
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("Add a plugin carries the current marketplace into the creator", {
          voiceover: vo[2],
          action: async () => {
            await ctx.clickText("Add a plugin", { selector: "a", timeoutMs: 15_000 });
            await ctx.waitFor("location.pathname === '/dashboard/plugins/new'", { timeoutMs: 30_000, label: "plugin creator route" });
            await ctx.waitFor(`(() => {
              const query = new URLSearchParams(location.search).get('marketplaceId');
              const control = [...document.querySelectorAll('button')].find((entry) =>
                (entry.textContent ?? '').trim() === ${JSON.stringify(state.marketplaceName)}
              );
              return query === ${JSON.stringify(state.marketplaceId)} && Boolean(control);
            })()`, { timeoutMs: 30_000, label: "marketplace preselected" });
            await ctx.eval(`(() => {
              const label = [...document.querySelectorAll('label')].find((entry) =>
                (entry.textContent ?? '').trim() === 'Marketplace'
              );
              label?.parentElement?.scrollIntoView({ block: 'center' });
              return true;
            })()`);
          },
          assert: async () => {
            const selected = await ctx.eval(`(() => ({
              label: [...document.querySelectorAll('button')].find((entry) =>
                (entry.textContent ?? '').trim() === ${JSON.stringify(state.marketplaceName)}
              )?.textContent?.trim() ?? null,
              query: new URLSearchParams(location.search).get('marketplaceId'),
            }))()`);
            witness(
              ctx,
              selected.query === state.marketplaceId
                && selected.label === state.marketplaceName,
              "The plugin creator preselects the marketplace from the Add a plugin action",
              selected,
            );
          },
          screenshot: screenshot(
            "plugin-marketplace-preselected",
            "The plugin creator visibly preselects the marketplace that launched it.",
            ["Create a plugin", "Share", "Marketplace", state.marketplaceName],
          ),
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("Connectors has one Add MCP action and no plugin-bundle import path", {
          voiceover: vo[3],
          action: async () => {
            await navigateTo(ctx, "/dashboard/mcp-connections");
            await ctx.waitForText("Connectors is where you can add MCP servers", { timeoutMs: 30_000 });
          },
          assert: async () => {
            const state = await ctx.eval(`(() => ({
              addMcpButtons: [...document.querySelectorAll('button')]
                .filter((entry) => (entry.textContent ?? '').trim() === 'Add MCP').length,
              betaVisible: document.body.innerText.toLowerCase().includes('beta'),
              pluginBundleVisible: document.body.innerText.includes('Plugin bundle'),
            }))()`);
            witness(ctx, state.addMcpButtons === 1, "Connectors presents exactly one Add MCP button", state);
            witness(ctx, state.betaVisible, "Connectors is visibly marked Beta", state);
            witness(ctx, !state.pluginBundleVisible, "The plugin-bundle import source is absent", state);
          },
          screenshot: screenshot(
            "connectors-beta-add-mcp",
            "Connectors is a Beta team MCP surface with one Add MCP action and reusable Quick add.",
            ["Connectors", "BETA", "Add MCP", "QUICK ADD", "Google Workspace", "Microsoft 365"],
          ),
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await ctx.prove("General settings shows the deployed commit and keeps owner-only controls disabled for admins", {
          voiceover: vo[4],
          action: async () => {
            await navigateTo(ctx, "/dashboard/org-settings");
            await ctx.waitFor(`Boolean(document.querySelector('[data-den-runtime-version]'))`, {
              timeoutMs: 30_000,
              label: "Den runtime version",
            });
          },
          assert: async () => {
            const general = await ctx.eval(`(() => {
              const nameLabel = [...document.querySelectorAll('label')].find((entry) =>
                [...entry.children].some((child) => (child.textContent ?? '').trim() === 'Name')
              );
              return {
                version: document.querySelector('[data-den-runtime-version]')?.getAttribute('data-den-runtime-version') ?? null,
                versionText: document.querySelector('[data-den-runtime-version]')?.textContent?.trim() ?? null,
                nameDisabled: nameLabel?.querySelector('input')?.disabled ?? null,
                hasDiagnostics: document.body.innerText.includes('Den egress diagnostic'),
              };
            })()`);
            witness(
              ctx,
              general.version === EXPECTED_VERSION && general.versionText === `Den ${EXPECTED_VERSION}`,
              "General settings shows the actual Den deployment version",
              general,
            );
            witness(ctx, general.nameDisabled === true, "Organization identity remains owner-only for an admin", general);
            witness(ctx, general.hasDiagnostics === false, "General settings no longer embeds egress diagnostics", general);
          },
          screenshot: screenshot(
            "general-settings-deployed-commit",
            "General settings visibly reports the actual Den commit while owner-only identity stays disabled.",
            ["Org settings", `Den ${EXPECTED_VERSION}`, "Organization Identity", "Name"],
          ),
        });
      },
    },
    {
      name: "Frame 6",
      run: async (ctx) => {
        await ctx.prove("Admins can save desktop-version policy but cannot mutate owner-only organization fields", {
          voiceover: vo[5],
          action: async () => {
            await ctx.waitFor(`Boolean([...document.querySelectorAll('input[type="checkbox"]')].find((entry) =>
              entry.getAttribute('aria-label')?.startsWith('Allow desktop version') && !entry.disabled
            ))`, { timeoutMs: 30_000, label: "enabled desktop version checkbox" });
            await ctx.eval(`(() => {
              const checkbox = [...document.querySelectorAll('input[type="checkbox"]')].find((entry) =>
                entry.getAttribute('aria-label')?.startsWith('Allow desktop version') && !entry.disabled
              );
              checkbox?.scrollIntoView({ block: 'center' });
              checkbox?.click();
              return Boolean(checkbox);
            })()`);
            await ctx.clickText("Save settings", { selector: "button", timeoutMs: 15_000 });
            await ctx.waitForText("Workspace settings updated.", { timeoutMs: 30_000 });
            await ctx.eval(`(() => {
              const heading = [...document.querySelectorAll('h2')].find((entry) =>
                (entry.textContent ?? '').trim() === 'Allowed Desktop Versions'
              );
              heading?.scrollIntoView({ block: 'start' });
              return Boolean(heading);
            })()`);
          },
          assert: async () => {
            const versionControl = await ctx.eval(`(() => {
              const checkbox = [...document.querySelectorAll('input[type="checkbox"]')].find((entry) =>
                entry.getAttribute('aria-label')?.startsWith('Allow desktop version')
              );
              return {
                enabled: checkbox ? !checkbox.disabled : false,
                hasSave: [...document.querySelectorAll('button')].some((entry) => (entry.textContent ?? '').includes('Save settings')),
                adminCopy: document.body.innerText.includes('Admins can change allowed desktop versions'),
              };
            })()`);
            witness(ctx, versionControl.enabled && versionControl.hasSave && versionControl.adminCopy, "Desktop version controls are editable and saveable for an admin", versionControl);

            const rejected = await denFetch("/v1/org", {
              method: "PATCH",
              headers: authHeaders(state.adminToken),
              body: JSON.stringify({ name: "This admin must not rename the workspace" }),
            });
            witness(ctx, rejected.response.status === 403, "The API rejects an admin's owner-only organization-name change", {
              status: rejected.response.status,
              body: rejected.body,
            });
          },
          screenshot: screenshot(
            "admin-desktop-version-controls",
            "Allowed Desktop Versions is enabled for admins and retains a Save settings action.",
            ["Allowed Desktop Versions", "Admins can change allowed desktop versions", "Save settings"],
          ),
        });
      },
    },
    {
      name: "Frame 7",
      run: async (ctx) => {
        await ctx.prove("Egress diagnostics lives on its own Settings page", {
          voiceover: vo[6],
          action: async () => {
            await navigateTo(ctx, "/dashboard/diagnostics");
            await ctx.waitForText("Den egress diagnostic", { timeoutMs: 30_000 });
          },
          assert: async () => {
            await ctx.expectText("Run egress diagnostic");
            const route = await ctx.eval("location.pathname");
            witness(ctx, route === "/dashboard/diagnostics", "Diagnostics has a dedicated route", { route });
          },
          screenshot: screenshot(
            "settings-diagnostics",
            "Settings contains a dedicated Diagnostics page with the existing egress support action.",
            ["Diagnostics", "Den egress diagnostic", "Run egress diagnostic"],
          ),
        });
      },
    },
    {
      name: "Frame 8",
      run: async (ctx) => {
        await ctx.prove("The managed square icon drives the sidebar and favicon without gray or loading artifacts", {
          voiceover: vo[7],
          action: async () => {
            await signInViaBrowser(ctx, OWNER_EMAIL, PASSWORD);
            await navigateTo(ctx, "/dashboard");
            await ctx.waitForText("Quick add", { timeoutMs: 30_000 });
            await uploadManagedIcon(ctx);
            await ctx.eval("location.reload()");
            await ctx.waitFor(`Boolean(document.querySelector('[data-sidebar-brand-icon="ready"]'))`, {
              timeoutMs: 30_000,
              label: "managed sidebar icon",
            });
            await navigateTo(ctx, "/dashboard/brand-appearance");
            await ctx.waitForText("Stored in this Den", { timeoutMs: 30_000 });
          },
          assert: async () => {
            const branding = await ctx.eval(`(() => {
              const mark = document.querySelector('[data-sidebar-brand-icon]');
              const image = mark?.querySelector('img');
              const favicon = document.head.querySelector('link[rel="icon"]');
              const previewLabel = [...document.querySelectorAll('p')].find((entry) =>
                (entry.textContent ?? '').trim() === 'Preview'
              );
              const preview = previewLabel?.parentElement ?? null;
              const hasThinLoadingLine = preview ? [...preview.querySelectorAll('div')].some((entry) => {
                const rect = entry.getBoundingClientRect();
                const style = getComputedStyle(entry);
                return rect.width > 80
                  && rect.height > 0
                  && rect.height <= 6
                  && style.backgroundColor !== 'rgba(0, 0, 0, 0)'
                  && style.backgroundColor !== 'transparent';
              }) : null;
              return {
                state: mark?.getAttribute('data-sidebar-brand-icon') ?? null,
                src: image?.getAttribute('src') ?? null,
                background: mark ? getComputedStyle(mark).backgroundColor : null,
                favicon: favicon?.href ?? null,
                expectedFavicon: new URL(${JSON.stringify(state.iconUrl)}, location.origin).href,
                naturalWidth: image?.naturalWidth ?? 0,
                hasThinLoadingLine,
              };
            })()`);
            witness(
              ctx,
              branding.state === "ready"
                && branding.src === state.iconUrl
                && branding.background === "rgba(0, 0, 0, 0)"
                && branding.naturalWidth === 128,
              "The sidebar uses the square managed icon with a transparent wrapper",
              branding,
            );
            witness(ctx, branding.favicon === branding.expectedFavicon, "The browser favicon uses the same managed square icon", branding);
            witness(ctx, branding.hasThinLoadingLine === false, "The brand preview contains no stray loading line", branding);
          },
          screenshot: screenshot(
            "brand-icon-favicon-preview",
            "The saved square icon appears cleanly in the sidebar and brand preview with no gray tile or loading line.",
            ["Brand appearance", "Desktop identity", "Preview", "Square app icon", "Stored in this Den"],
          ),
        });
      },
    },
  ],
};
