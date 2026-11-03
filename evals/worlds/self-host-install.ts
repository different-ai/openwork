import { allocateFreePorts, listTargets } from "@openwork/cdp";
import { denFetch, readHandoffDeepLink, type DenSession } from "@openwork/behaviors";
import { personDefaults, type Place, type Seed } from "@openwork/env";
import { invitationWitnesses, localInviteNeeds, record, text } from "./org-invite.ts";

/** Starts a private single-org Den; specs pass the testkit's `selfHostServer`. */
export type StartSelfHostServer = (options: {
  place: Place;
  name: string;
  slug: string;
  ownerEmails: string[];
  allowPublicSignup?: boolean;
  bootstrapCode?: string;
  trustedOrigins?: string[];
  env?: Record<string, string>;
}) => Promise<{ ref: { apiUrl: string; webUrl: string } } & AsyncDisposable>;

/** Pinned so the install page never asks GitHub which release is current. */
export const SELF_HOST_INSTALLER_VERSION = "0.18.0";

/**
 * A private single-org Den the way an operator runs it: public sign-up off,
 * one bootstrap owner, and an emailed invitation for a teammate who has no
 * account yet. A fresh OpenWork app in headless Chrome knows no server and requires sign-in,
 * as the Enterprise installer does on first launch; only its origin is trusted by Den.
 */
export async function selfHostInviteToDesktop(seed: Seed, { place }: { place: Place }, selfHostServer: StartSelfHostServer) {
  await localInviteNeeds();
  const runId = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const owner = personDefaults("self-host-owner", undefined, runId);
  const teammate = personDefaults("self-host-teammate", { email: `teammate-${runId}@outside.test` }, runId);
  const workspaceName = `Private workspace ${runId}`;
  const bootstrapCode = `test-bootstrap-${runId}`;
  const [appPort] = await allocateFreePorts(1);
  if (!appPort) throw new Error("No port available for the app in a browser.");
  const server = await selfHostServer({
    place,
    name: workspaceName,
    slug: `private-${runId}`,
    ownerEmails: [owner.email],
    allowPublicSignup: false,
    bootstrapCode,
    trustedOrigins: [`http://127.0.0.1:${appPort}`],
    env: { OPENWORK_INSTALLER_RELEASE_TAG: `v${SELF_HOST_INSTALLER_VERSION}`, DEN_DESKTOP_RELEASES_MODE: "static" },
  });
  try {
    const den = await seed.den({ reuse: server.ref, provision: false });
    const anonymous = den.admin;

    // The bootstrap owner claims the server, as in the self-host invite journey.
    const verified = await seed.api(anonymous, "/v1/auth/bootstrap/verify", {
      method: "POST", body: JSON.stringify({ email: owner.email, code: bootstrapCode }), signal: AbortSignal.timeout(15_000),
    });
    if (!verified.response.ok) throw new Error(`Bootstrap verify: HTTP ${verified.response.status} ${verified.text.slice(0, 300)}`);
    const created = await seed.api(anonymous, "/api/auth/sign-up/email", {
      method: "POST", body: JSON.stringify({ ...owner, bootstrapGrant: text(record(verified.body).grant) }), signal: AbortSignal.timeout(15_000),
    });
    if (!created.response.ok) throw new Error(`Owner sign-up: HTTP ${created.response.status} ${created.text.slice(0, 300)}`);
    const ownerSession = await invitationWitnesses(anonymous).sessionFor(owner);
    den.admin = ownerSession;
    const witness = invitationWitnesses(ownerSession);
    const [organization] = await witness.orgs();
    if (!organization) throw new Error("The self-hosted server has no organization.");
    const organizationId = text(organization.id);
    const invite = await witness.invite(teammate.email, organizationId);

    const web = await seed.web({ den, headless: true, viewport: { width: 1280, height: 900, deviceScaleFactor: 1 } });
    const app = await seed.appWeb({
      name: "self-host-install",
      workspacePath: seed.tmpPath("self-host-install"),
      webPort: appPort,
      // Enterprise builds always require sign-in, so a fresh app opens on its
      // sign-in screen. The desktop shell learns a server's API address from
      // its /api/runtime-config and calls it outside browser CORS rules; the
      // browser build cannot, so the API address is pinned at build time.
      // The server address itself is still unknown until the member enters it.
      env: { VITE_DEN_REQUIRE_SIGNIN: "true", VITE_DEN_API_BASE_URL: server.ref.apiUrl },
      mouse: true,
    });
    const appPageIds = new Set((await listTargets(app.handle.cdpUrl)).filter((target) => target.type === "page").map((target) => target.id));

    /** Den's answer to a download request, without following it to the release host. */
    async function download(session: DenSession | null, platform = "mac-arm64") {
      const result = await denFetch(session ?? server.ref, `/v1/me/install/${platform}`, {
        redirect: "manual",
        headers: session ? { authorization: `Bearer ${session.token}` } : {},
        signal: AbortSignal.timeout(15_000),
      });
      return { status: result.response.status, location: result.response.headers.get("location") };
    }

    /** The workspace address the install page tells a member to enter in the app. */
    async function workspaceAddress(session: DenSession) {
      const result = await denFetch(session, "/v1/me/install-config", {
        headers: { authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(15_000),
      });
      if (!result.response.ok) throw new Error(`Install config: HTTP ${result.response.status}`);
      return text(record(result.body).webUrl);
    }

    /** The sign-in page the app opened in the browser, observed without replacing window.open. */
    async function appOpenedSignIn() {
      const opened = (await listTargets(app.handle.cdpUrl)).find((target) => target.type === "page" && !appPageIds.has(target.id) && target.url.includes("desktopAuth=1"));
      return opened?.url ?? null;
    }

    /** The API address the server publishes; the desktop shell reads the same field before exchanging a grant. */
    async function publishedApiUrl(webUrl: string) {
      const response = await fetch(new URL("/api/runtime-config", webUrl), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`Runtime config: HTTP ${response.status}`);
      return text(record(await response.json()).denApiUrl);
    }

    /** What an unauthenticated caller learns from the public install configuration. */
    async function publicInstallConfig() {
      const response = await fetch(`${server.ref.apiUrl}/v1/install-config?token=old-shared-link`, { signal: AbortSignal.timeout(15_000) });
      return { status: response.status, body: record(await response.json()) };
    }

    return {
      den, web, app, owner, teammate, invite, organizationId, workspaceName, witness,
      download, publicInstallConfig, workspaceAddress, appOpenedSignIn, publishedApiUrl,
      /** The openwork:// sign-in link the signed-in browser shows after a desktop sign-in request. */
      readHandoffLink: () => readHandoffDeepLink(web),
      /** A browser with no Den session, for the signed-out half of the journey. */
      signedOutBrowser: () => seed.web({ den, headless: true, viewport: { width: 1280, height: 900, deviceScaleFactor: 1 } }),
      sessionFor: (person: { email: string; password: string }) => witness.sessionFor(person),
      async [Symbol.asyncDispose]() { await server[Symbol.asyncDispose](); },
    };
  } catch (error) {
    await server[Symbol.asyncDispose]();
    throw error;
  }
}
