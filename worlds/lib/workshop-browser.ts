import { browserScript, connect, debuggerUrlFor, listTargets } from "../../evals/packages/cdp/src/index.ts";
import type { Surface } from "../../evals/packages/cdp/src/index.ts";
import { evalIn, waitFor } from "../../evals/packages/behaviors/src/desktop.ts";
import { signInInBrowser } from "../../evals/packages/behaviors/src/browser-handoff.ts";
import { denFetch } from "../../evals/packages/behaviors/src/den.ts";
import type { DenSession } from "../../evals/packages/behaviors/src/den.ts";
import { defaultDaytonaExec } from "../../evals/packages/hosts/src/daytona.ts";
import { execInSandbox } from "../../evals/packages/hosts/src/provision.ts";

export const WORKSHOP_BROWSER_PROFILE = "/home/daytona/workshop/browser";
export const WORKSHOP_BROWSER_LAUNCHER = "/home/daytona/workshop/open-browser";
export const WORKPLACE_ORIGIN = "https://open-workplace-workshop.onrender.com";
const APPS = ["outlook", "calendar", "drive", "jira", "confluence"];
export const WORKSHOP_ALLOW_LABEL = "^(allow(?: workplace)?|authorize|approve)( access)?$";
export const WORKSHOP_GUEST_PATTERN = "\\bWorkshop guest ([1-9]\\d*)\\b";

export function workshopBrowserInstaller(): string {
  // Use the same binary and caller-owned profile as host.spawnChrome. Chrome's
  // SingleInstance IPC hands OS-opened URLs to that already running process.
  return `set -eu
export DISPLAY=:99
mkdir -p /home/daytona/workshop/workspace ${WORKSHOP_BROWSER_PROFILE} "$HOME/.local/share/applications"
# Operator-approved run mode is scoped to this new fictional workspace only.
# Credentials stay in Den's broker; this file contains no provider configuration.
test ! -e /home/daytona/workshop/workspace/opencode.json
cat > /home/daytona/workshop/workspace/opencode.json <<'JSON'
{"permission":{"*":"allow"}}
JSON
chrome=$(command -v chromium || command -v google-chrome || command -v google-chrome-stable)
printf '#!/bin/sh\\nexport DISPLAY=:99\\nexec %s --no-sandbox --disable-dev-shm-usage --user-data-dir=${WORKSHOP_BROWSER_PROFILE} "$@"\\n' "$chrome" > ${WORKSHOP_BROWSER_LAUNCHER}
chmod 700 ${WORKSHOP_BROWSER_LAUNCHER}
cat > "$HOME/.local/share/applications/openwork-workshop-browser.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=Workshop browser
Exec=${WORKSHOP_BROWSER_LAUNCHER} %u
Terminal=false
MimeType=x-scheme-handler/http;x-scheme-handler/https;text/html;
DESKTOP
xdg-settings set default-web-browser openwork-workshop-browser.desktop
xdg-mime default openwork-workshop-browser.desktop x-scheme-handler/http
xdg-mime default openwork-workshop-browser.desktop x-scheme-handler/https
test "$(xdg-mime query default x-scheme-handler/http)" = openwork-workshop-browser.desktop
test "$(xdg-mime query default x-scheme-handler/https)" = openwork-workshop-browser.desktop
`;
}

/** execInSandbox wraps its argument in single quotes; transport scripts as data. */
export function workshopRemoteScript(script: string): string {
  return `printf %s ${Buffer.from(script).toString("base64")} | base64 -d | bash`;
}

export async function installWorkshopBrowser(sandboxId: string): Promise<void> {
  await execInSandbox(defaultDaytonaExec, sandboxId, workshopRemoteScript(workshopBrowserInstaller()), {
    timeoutMs: 120_000, context: "register attendee-owned system browser",
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function navigate(browser: Surface, url: string): Promise<void> {
  await evalIn(browser, browserScript((url) => { location.href = url; return true; }, [url]));
}

export async function guestLabel(browser: Surface, app: string): Promise<string> {
  await navigate(browser, `${WORKPLACE_ORIGIN}/${app}`);
  const label = await waitFor(browser, browserScript((app, pattern) => {
    if (location.pathname !== `/${app}` || document.readyState !== "complete") return false;
    // Outlook/Calendar show initials; the real account name is their native
    // tooltip. Atlassian exposes it as the avatar's accessible name as well.
    const labels = [...document.querySelectorAll<HTMLElement>('header .account[title], header .avatar[title], header .avatar[aria-label]')]
      .map((element) => element.getAttribute("aria-label") || element.getAttribute("title") || "");
    for (const text of labels) {
      const match = text.match(new RegExp(pattern, "i"));
      if (match) return `Workshop guest ${match[1]}`;
    }
    return false;
  }, [app, WORKSHOP_GUEST_PATTERN]), { timeoutMs: 60_000, label: "provider account tooltip or accessible guest identity" });
  if (typeof label !== "string") throw new Error("Provider did not expose an attendee guest identity.");
  return label;
}

/** Real separate cookie jar per VM; never inject an admin cookie or copy a profile. */
export async function connectWorkshopBrowser(browser: Surface, member: DenSession, orgId: string,
  connections: readonly { key: string; id: string }[]): Promise<{ guest: string; connected: number }> {
  await signInInBrowser(browser, member.webUrl, { email: member.email, password: member.password });
  await navigate(browser, WORKPLACE_ORIGIN);
  const headers = { authorization: `Bearer ${member.token}`, "x-openwork-org-id": orgId };
  for (const connection of connections) {
    // Den's OAuth handshake with the workplace (discovery + client registration)
    // can fail transiently when many seats start at once: retry with backoff.
    let started = await denFetch(member, `/v1/mcp-connections/${encodeURIComponent(connection.id)}/connect/start`, { headers });
    for (let attempt = 2; attempt <= 5 && (started.response.status === 424 || started.response.status === 429 || started.response.status >= 500); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 3_000 * attempt + Math.floor(Math.random() * 2_000)));
      started = await denFetch(member, `/v1/mcp-connections/${encodeURIComponent(connection.id)}/connect/start`, { headers });
    }
    if (!started.response.ok || !record(started.body) || typeof started.body.authorizeUrl !== "string") {
      // The 424 body is Den's provider diagnostic; it carries no credentials.
      const reason = record(started.body) ? String(started.body.message ?? started.body.error ?? started.body.reason ?? "").slice(0, 300) : "";
      throw new Error(`Attendee OAuth start failed for ${connection.key}: HTTP ${started.response.status}${reason ? ` (${reason})` : ""}.`);
    }
    const authorize = new URL(started.body.authorizeUrl);
    if (authorize.origin !== WORKPLACE_ORIGIN) throw new Error("Unexpected workplace OAuth issuer.");
    await navigate(browser, authorize.href);
    await waitFor(browser, browserScript((pattern) => {
      const allow = [...document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input[type="submit"]')]
        .find((button) => new RegExp(pattern, "i").test((button.textContent || (button instanceof HTMLInputElement ? button.value : "")).trim()) && !button.disabled);
      if (!allow) return false;
      allow.click();
      return true;
    }, [WORKSHOP_ALLOW_LABEL]), { timeoutMs: 60_000, label: `approve attendee ${connection.key} OAuth` });
    // The callback must settle and the authenticated member API must confirm it.
    await waitFor(browser, browserScript((origins) => origins.includes(location.origin), [[new URL(member.apiUrl).origin, new URL(member.webUrl).origin]]), {
      timeoutMs: 60_000, label: "Den OAuth callback",
    });
    const deadline = Date.now() + 60_000;
    let connected = false;
    while (Date.now() < deadline) {
      const response = await denFetch(member, "/v1/mcp-connections?scope=usable", { headers });
      const value = record(response.body) && Array.isArray(response.body.connections)
        ? response.body.connections.find((entry) => record(entry) && entry.id === connection.id) : undefined;
      if (response.response.ok && record(value) && value.connectedForMe === true && value.needsReconnect !== true) { connected = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!connected) throw new Error(`Attendee ${connection.key} OAuth did not become connectedForMe.`);
  }
  const labels: string[] = [];
  for (const app of APPS) labels.push(await guestLabel(browser, app));
  const guest = labels[0];
  if (!guest || labels.some((label) => label !== guest)) throw new Error("Five workplace apps did not retain the same per-attendee Guest identity.");
  await navigate(browser, `${WORKPLACE_ORIGIN}/outlook`);
  return { guest, connected: connections.length };
}

/** Verify the browser's real system handoff reuses its existing cookie jar. */
export async function verifyWorkshopBrowserHandoff(sandboxId: string, browser: Surface, guest: string): Promise<void> {
  const before = new Set((await listTargets(browser.handle.cdpUrl)).map((target) => target.id));
  await execInSandbox(defaultDaytonaExec, sandboxId, workshopRemoteScript(`DISPLAY=:99 BROWSER=${WORKSHOP_BROWSER_LAUNCHER} xdg-open '${WORKPLACE_ORIGIN}/outlook'`), {
    timeoutMs: 30_000, context: "real OS HTTP browser handoff",
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const target = (await listTargets(browser.handle.cdpUrl)).find((target) => !before.has(target.id) && target.type === "page" && target.url.startsWith(`${WORKPLACE_ORIGIN}/outlook`));
    if (target) {
      const client = await connect(debuggerUrlFor(browser.handle.cdpUrl, target));
      try {
        await waitFor({ handle: browser.handle, client }, browserScript((guest) => [...document.querySelectorAll<HTMLElement>('header .account[title], header .avatar[aria-label]')]
          .some((element) => (element.getAttribute("title") || element.getAttribute("aria-label") || "").includes(guest)), [guest]), {
          timeoutMs: 30_000, label: "OS-opened tab retains existing Guest cookie jar",
        });
        await browser.client.send("Target.closeTarget", { targetId: target.id });
        return;
      } finally { client.close(); }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("System browser handoff did not open in the existing attendee Chrome process.");
}

/** Keep the authenticated browser alive, but give the attendee the actual app. */
export async function foregroundWorkshopDesktop(browser: Surface, desktop: Surface): Promise<void> {
  const window = await browser.client.send("Browser.getWindowForTarget");
  if (!record(window) || typeof window.windowId !== "number") throw new Error("Cannot identify the attendee browser window.");
  await browser.client.send("Browser.setWindowBounds", { windowId: window.windowId, bounds: { windowState: "minimized" } });
  await desktop.client.send("Page.bringToFront");
}
