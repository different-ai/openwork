import { allocateFreePorts, connect, debuggerUrlFor, listTargets } from "@openwork/cdp";
import type { Surface } from "@openwork/cdp";
import { faultProxy } from "@openwork/env";
import type { Place, Seed } from "@openwork/env";
import { enableOrganizationCapabilities } from "./dashboards.ts";
import { isRecord, stringField } from "./library.ts";

type DownloadScenario = "admin" | "failures" | "member" | "capability-off";

/** Real Den minting and real Chromium clipboard/popups; only the first failed mint is synthetic. */
async function downloadWorkspace(seed: Seed, ctx: { place: Place }, scenario: DownloadScenario) {
  if (ctx.place.kind !== "local") throw new Error("This world pins the Den API proxy before boot; run with --local.");
  const [apiPort, webPort] = await allocateFreePorts(2);
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const proxy = await faultProxy({ apiUrl, webUrl: apiUrl }, { place: ctx.place });
  const popupClients: Surface["client"][] = [];
  const organizationName = "Download Lab";
  const den = await seed.den({
    ports: { api: apiPort, web: webPort },
    org: { name: organizationName, admin: { name: "Download Admin" }, members: { teammate: { name: "Download Teammate" } } },
    env: {
      DEN_API_PUBLIC_URL: proxy.ref.webUrl,
      // Pin the release so opening /install never asks GitHub for a release.
      OPENWORK_INSTALLER_RELEASE_TAG: "v0.18.0",
      DEN_DESKTOP_RELEASES_MODE: "static",
    },
    webApiBase: proxy.ref.webUrl,
  });
  const organizationId = await enableOrganizationCapabilities(seed, den.admin, { installLinks: true });
  if (scenario === "capability-off") {
    const disabled = await seed.api(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, {
      method: "PUT", body: JSON.stringify({ capabilities: { installLinks: false } }),
    });
    if (!disabled.response.ok) throw new Error(`Disabling install links failed: HTTP ${disabled.response.status}`);
  }
  const mintPath = `/v1/orgs/${organizationId}/install-links`;
  if (scenario === "failures") {
    await proxy.faults.status(mintPath, 503, { times: 1, body: { error: "Install link temporarily unavailable. Please retry." } });
  }
  const web = await seed.web({
    den,
    signedInAs: scenario === "member" ? den.members.teammate : den.admin,
    startPath: "/dashboard",
    headless: true,
    viewport: { width: 1440, height: 1000 },
  });
  const origin = new URL(den.ref.webUrl).origin;
  const initialPageIds = new Set((await listTargets(web.handle.cdpUrl)).filter((target) => target.type === "page").map((target) => target.id));

  // TODO(primitive): seed needs a browser-permission helper. Use the real browser
  // permission, not a replacement clipboard API, so successful copies are genuine.
  async function allowClipboard() {
    await web.client.send("Browser.grantPermissions", {
      origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });
  }
  if (scenario === "failures") {
    await web.client.send("Browser.setPermission", {
      origin, permission: { name: "clipboard-write" }, setting: "denied",
    });
  } else {
    await allowClipboard();
  }

  return {
    den, web, organizationName, organizationId, allowClipboard,
    async mintRequests() {
      return (await proxy.requestLog()).filter((entry) => entry.method === "POST" && entry.path === mintPath);
    },
    // TODO(primitive): probe.location and probe.clipboard should expose these
    // read-only witnesses without per-world browser evaluation.
    async location() {
      return seed.evalIn(web, () => window.location.pathname + window.location.search);
    },
    async readClipboard() {
      return seed.evalIn(web, () => navigator.clipboard.readText(), { awaitPromise: true });
    },
    /** Resolve the copied token through Den, not a regex-only or synthetic URL witness. */
    async resolveInstallLink(href: string) {
      const url = new URL(href);
      if (url.origin !== origin || url.pathname !== "/install" || !url.searchParams.get("token")) {
        throw new Error("Expected a local workspace install URL containing a minted token.");
      }
      const response = await fetch(`${apiUrl}/v1/install-config?token=${encodeURIComponent(url.searchParams.get("token") ?? "")}`, {
        signal: AbortSignal.timeout(15_000),
      });
      const body: unknown = await response.json();
      return { status: response.status, organizationName: stringField(body, "clientName"), requireSignin: isRecord(body) && body.requireSignin === true };
    },
    async newPageCount() {
      return (await listTargets(web.handle.cdpUrl)).filter((target) => target.type === "page" && !initialPageIds.has(target.id)).length;
    },
    /** Observe the real tab opened by the trusted click; never replace window.open. */
    async installPopup(): Promise<{ surface: Surface; url: string } | null> {
      const target = (await listTargets(web.handle.cdpUrl)).find((entry) => (
        entry.type === "page" && entry.id !== web.client.targetId && entry.url.startsWith(`${origin}/install?token=`)
      ));
      if (!target) return null;
      const client = await connect(debuggerUrlFor(web.handle.cdpUrl, target));
      popupClients.push(client);
      return { surface: { handle: web.handle, client }, url: target.url };
    },
    async [Symbol.asyncDispose]() {
      for (const client of popupClients) client.close();
      await proxy[Symbol.asyncDispose]();
    },
  };
}

export const denDownloadAdmin = (seed: Seed, ctx: { place: Place }) => downloadWorkspace(seed, ctx, "admin");
export const denDownloadFailures = (seed: Seed, ctx: { place: Place }) => downloadWorkspace(seed, ctx, "failures");
export const denDownloadMember = (seed: Seed, ctx: { place: Place }) => downloadWorkspace(seed, ctx, "member");
export const denDownloadCapabilityOff = (seed: Seed, ctx: { place: Place }) => downloadWorkspace(seed, ctx, "capability-off");
