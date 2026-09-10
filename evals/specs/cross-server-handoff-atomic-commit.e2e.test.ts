import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, onTestFinished } from "vitest";
import { clickButton, denFetch, signIn } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import {
  app,
  control,
  createDesktopHandoffGrant,
  electronProfilePaths,
  evalIn,
  eventually,
  localMysqlIsRunning,
  needs,
  quitDesktop,
  readDenClientState,
  relaunchDesktop,
  server,
  test,
} from "@openwork/testkit";
import type { App, DesktopHandle, Surface } from "@openwork/testkit";

/**
 * A cross-server handoff is an atomic enrollment transaction: accepting a
 * sign-in for control plane B while control plane A is active must switch the
 * durable bootstrap origin, the session credential, and the active
 * organization together — or leave the complete A enrollment untouched.
 *
 * This spec drives the real desktop app between two independent Den servers
 * with an injected bootstrap-persistence failure (the profile root is made
 * read-only, so the shell's atomic bootstrap write fails), and asserts both
 * halves: the failed handoff changes nothing, and the retried handoff with a
 * fresh grant commits everything together, survives a restart, and keeps
 * one-time grants single-use. The OS deep-link dispatch is bridged through
 * the product's own documented control seam (`auth.exchange-grant`), exactly
 * like every signed-in app boot in this suite.
 */

const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const localPlacement = process.env.OPENWORK_EVAL_DAYTONA !== "1" && !process.env.OPENWORK_EVAL_DEN_API_URL?.trim();
const mysqlOpen = await localMysqlIsRunning();
const title = !e2eTestsEnabled
  ? "cross-server handoff atomic commit skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1"
  : !localPlacement
    ? "cross-server handoff atomic commit skipped — needs local placement without OPENWORK_EVAL_DEN_API_URL"
    : !mysqlOpen
      ? "cross-server handoff atomic commit skipped — needs MySQL on 127.0.0.1:3306"
      : "a cross-server handoff commits origin, credential, and organization atomically or not at all";

const ORG_A = "Handoff Atomic A";
const ORG_B = "Handoff Atomic B";
const LOCAL_SERVER_STABILITY_MS = 3_000;

type LocalServerResponse = { status: number; body: unknown };
type LocalServerIdentity = {
  managedPolicy: LocalServerResponse;
  providerSync: LocalServerResponse;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function localServerResponse(value: unknown, path: string): LocalServerResponse {
  if (!isRecord(value) || typeof value.status !== "number" || !("body" in value)) {
    throw new Error(`Invalid local-server response for ${path}: ${JSON.stringify(value)}`);
  }
  return { status: value.status, body: value.body };
}

/** Read-only, secret-free proof through the renderer's authenticated local-server boundary. */
async function readLocalServerIdentity(surface: Surface): Promise<LocalServerIdentity> {
  const value = await evalIn(surface, async () => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    if (!info?.running || !info.baseUrl) return { error: "local_server_unavailable" };
    const request = async (path: string) => {
      const response = await fetch(String(info.baseUrl).replace(/\/+$/, "") + path, {
        headers: { Authorization: "Bearer " + String(info.ownerToken ?? info.clientToken ?? "") },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      const text = await response.text();
      let body: unknown = text;
      try { body = text ? JSON.parse(text) : null; } catch {}
      return { status: response.status, body };
    };
    const [managedPolicy, providerSync] = await Promise.all([
      request("/managed-policy"),
      request("/cloud-provider-sync/status"),
    ]);
    return { managedPolicy, providerSync };
  }, { awaitPromise: true, timeoutMs: 30_000 });
  if (!isRecord(value)) throw new Error(`Invalid local-server identity response: ${JSON.stringify(value)}`);
  return {
    managedPolicy: localServerResponse(value.managedPolicy, "/managed-policy"),
    providerSync: localServerResponse(value.providerSync, "/cloud-provider-sync/status"),
  };
}

function isUsableLocalIdentity(identity: LocalServerIdentity, allowAlphaUpdates: boolean): boolean {
  return identity.managedPolicy.status === 200
    && isRecord(identity.managedPolicy.body)
    && isRecord(identity.managedPolicy.body.policy)
    && identity.managedPolicy.body.policy.allowAlphaUpdates === allowAlphaUpdates
    && identity.providerSync.status === 200
    && isRecord(identity.providerSync.body)
    && identity.providerSync.body.hasSession === true;
}

function isSignedOutLocalIdentity(identity: LocalServerIdentity): boolean {
  return identity.managedPolicy.status === 403
    && isRecord(identity.managedPolicy.body)
    && identity.managedPolicy.body.code === "policy_unavailable"
    && identity.providerSync.status === 200
    && isRecord(identity.providerSync.body)
    && identity.providerSync.body.hasSession === false;
}

async function observeStableLocalIdentity(
  surface: Surface,
  allowAlphaUpdates: boolean,
): Promise<LocalServerIdentity[]> {
  const identities: LocalServerIdentity[] = [];
  const deadline = Date.now() + LOCAL_SERVER_STABILITY_MS;
  do {
    identities.push(await readLocalServerIdentity(surface));
    await delay(500);
  } while (Date.now() < deadline);
  expect(
    identities.every((identity) => isUsableLocalIdentity(identity, allowAlphaUpdates)),
    `Expected stable local-server identity with allowAlphaUpdates=${allowAlphaUpdates}: ${JSON.stringify(identities)}`,
  ).toBe(true);
  return identities;
}

async function setDefaultPolicyMarker(session: DenSession, allowAlphaUpdates: boolean): Promise<void> {
  const headers = { authorization: `Bearer ${session.token}` };
  const list = await denFetch(session, "/v1/desktop-policies", { headers });
  const policies = isRecord(list.body) && Array.isArray(list.body.desktopPolicies)
    ? list.body.desktopPolicies.filter(isRecord)
    : [];
  const current = policies.find((policy) => policy.isDefault === true);
  if (!list.response.ok || !current || typeof current.id !== "string" || !isRecord(current.policy)) {
    throw new Error(`Default desktop policy setup failed with HTTP ${list.response.status}.`);
  }
  const update = await denFetch(session, `/v1/desktop-policies/${encodeURIComponent(current.id)}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      policyName: typeof current.policyName === "string" ? current.policyName : "Default desktop policy",
      policy: { ...current.policy, allowAlphaUpdates },
    }),
  });
  if (!update.response.ok) {
    throw new Error(`Desktop policy marker update failed with HTTP ${update.response.status}: ${update.text}`);
  }
}

const EVENT_RECORDER = () => {
  if (!window.__handoffProofEvents) {
    window.__handoffProofEvents = [];
    window.addEventListener("openwork-den-session-updated", (event) => {
      window.__handoffProofEvents.push(String(event instanceof CustomEvent ? event.detail?.status ?? "unknown" : "unknown"));
    });
  }
  return true;
};

async function readSessionEvents(desktop: Surface): Promise<string[]> {
  const raw = await evalIn(desktop, () => (JSON.stringify(window.__handoffProofEvents ?? [])));
  return JSON.parse(String(raw)) as string[];
}

async function readEnrollmentOrigin(desktop: Surface): Promise<string | null> {
  const raw = await evalIn(
    desktop,
    () => (window.localStorage.getItem('openwork.den.sessionOrigin') ?? ''),
  );
  return String(raw).trim() || null;
}

async function readBootstrapFileBaseUrl(profileDir: string): Promise<string> {
  const { bootstrapPath } = electronProfilePaths(profileDir);
  const parsed = JSON.parse(await readFile(bootstrapPath, "utf8")) as { baseUrl?: string };
  return (parsed.baseUrl ?? "").replace(/\/+$/, "");
}

function normalizedUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/** True while something still accepts connections on the loopback port. */
function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port, timeout: 750 }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/** The stored session origin uses the product's origin comparison key, which
 * folds loopback aliases (127.0.0.1) into `localhost`. */
function sessionOriginKey(url: string): string {
  const parsed = new URL(url);
  if (["127.0.0.1", "0.0.0.0", "::1", "[::1]"].includes(parsed.hostname)) {
    parsed.hostname = "localhost";
  }
  return parsed.origin;
}

test.skipIf(!e2eTestsEnabled || !localPlacement || !mysqlOpen)(
  title,
  { timeout: 15 * 60_000 },
  async ({ evidence, place }) => {
    needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });

    await using denA = await server({
      place,
      org: {
        name: ORG_A,
        admin: {
          email: "handoff-atomic-admin-a@openwork.test",
          name: "Handoff Atomic Admin A",
          password: "OpenWorkEval123!",
        },
      },
    });
    await using denB = await server({
      place,
      org: {
        name: ORG_B,
        admin: {
          email: "handoff-atomic-admin-b@openwork.test",
          name: "Handoff Atomic Admin B",
          password: "OpenWorkEval123!",
        },
      },
    });
    await setDefaultPolicyMarker(denA.admin, false);
    await setDefaultPolicyMarker(denB.admin, true);

    const profileDir = await mkdtemp(join(tmpdir(), "openwork-handoff-atomic-"));
    onTestFinished(async () => {
      await chmod(profileDir, 0o755).catch(() => undefined);
      await rm(profileDir, { recursive: true, force: true });
    });

    let desktop: App | null = await app({ den: denA, as: "admin", place, profileDir });
    try {
      const runningDesktop = desktop;
      // The boot sign-in is itself a same-origin handoff through the same
      // transaction — its success proves same-origin handoffs still work.
      const stateA = await readDenClientState(desktop);
      expect(stateA.authTokenPresent).toBe(true);
      expect(stateA.activeOrgName).toBe(ORG_A);
      expect(await readEnrollmentOrigin(desktop)).toBe(sessionOriginKey(denA.ref.webUrl));
      const initialServerA = await eventually(() => readLocalServerIdentity(runningDesktop), {
        within: 60_000,
        label: "local server using A policy and provider-sync session",
        until: (identity) => isUsableLocalIdentity(identity, false),
      });
      expect(isUsableLocalIdentity(initialServerA, false)).toBe(true);
      evidence.recordAssertionEvidence(
        "Same-origin handoff enrolled usable control plane A state in the app and local server",
        `The app signed in to ${ORG_A}; /managed-policy returned A's false alpha-update marker and /cloud-provider-sync/status reported hasSession=true.`,
        true,
      );

      await evalIn(desktop, EVENT_RECORDER);

      // Injected bootstrap-persistence failure: the shell's atomic
      // bootstrap.json write (temp file + rename in the profile root) cannot
      // create its temp file in a read-only directory.
      await chmod(profileDir, 0o555);
      const consumedGrant = await createDesktopHandoffGrant(denB.admin);
      let failedError: string | null = null;
      try {
        await control(
          desktop,
          "auth.exchange-grant",
          { grant: consumedGrant, baseUrl: denB.ref.webUrl },
          { timeoutMs: 60_000 },
        );
      } catch (error) {
        failedError = error instanceof Error ? error.message : String(error);
      } finally {
        await chmod(profileDir, 0o755);
      }
      expect(failedError).toBeTruthy();

      // The complete A enrollment is still active: durable origin, session
      // credential, organization, and enrollment marker all remained A's.
      const stateAfterFailure = await readDenClientState(desktop);
      expect(stateAfterFailure.authTokenPresent).toBe(true);
      expect(stateAfterFailure.activeOrgName).toBe(ORG_A);
      expect(await readEnrollmentOrigin(desktop)).toBe(sessionOriginKey(denA.ref.webUrl));
      expect(await readBootstrapFileBaseUrl(profileDir)).toBe(normalizedUrl(denA.ref.webUrl));
      const eventsAfterFailure = await readSessionEvents(desktop);
      expect(eventsAfterFailure).toContain("error");
      expect(eventsAfterFailure).not.toContain("success");
      const serverSamplesAfterFailure = await observeStableLocalIdentity(runningDesktop, false);
      evidence.recordAssertionEvidence(
        "Bootstrap persistence failure left the complete A enrollment and local-server identity active",
        `With bootstrap writes failing, the B handoff was rejected and ${serverSamplesAfterFailure.length} local-server samples over ${LOCAL_SERVER_STABILITY_MS}ms kept A's policy marker and provider-sync session; no B success was published.`,
        true,
      );

      // Recovery needs a fresh handoff: the failed attempt consumed its
      // one-time grant. A new grant commits B's origin, token, and
      // organization together.
      const freshGrant = await createDesktopHandoffGrant(denB.admin);
      await control(
        desktop,
        "auth.exchange-grant",
        { grant: freshGrant, baseUrl: denB.ref.webUrl },
        { timeoutMs: 60_000 },
      );
      const stateB = await eventually(() => readDenClientState(runningDesktop), {
        within: 60_000,
        label: "committed B enrollment",
        until: (state) => state.activeOrgName === ORG_B,
      });
      expect(stateB.authTokenPresent).toBe(true);
      expect(stateB.activeOrgName).toBe(ORG_B);
      expect(await readEnrollmentOrigin(desktop)).toBe(sessionOriginKey(denB.ref.webUrl));
      expect(await readBootstrapFileBaseUrl(profileDir)).toBe(normalizedUrl(denB.ref.webUrl));
      const eventsAfterCommit = await readSessionEvents(desktop);
      expect(eventsAfterCommit).toContain("success");
      const committedServerB = await eventually(() => readLocalServerIdentity(runningDesktop), {
        within: 60_000,
        label: "local server switched to B policy and provider-sync session",
        until: (identity) => isUsableLocalIdentity(identity, true),
      });
      expect(isUsableLocalIdentity(committedServerB, true)).toBe(true);
      evidence.recordAssertionEvidence(
        "The retried handoff committed B atomically in the app and local server",
        `Origin (bootstrap file), credential, organization (${ORG_B}), enrollment marker, managed policy, and provider-sync session switched to B together.`,
        true,
      );

      // One-time grants stay single-use: replaying the consumed grant fails
      // and does not disturb the committed B enrollment.
      let replayError: string | null = null;
      try {
        await control(
          desktop,
          "auth.exchange-grant",
          { grant: consumedGrant, baseUrl: denB.ref.webUrl },
          { timeoutMs: 60_000 },
        );
      } catch (error) {
        replayError = error instanceof Error ? error.message : String(error);
      }
      expect(replayError).toBeTruthy();
      const stateAfterReplay = await readDenClientState(desktop);
      expect(stateAfterReplay.activeOrgName).toBe(ORG_B);
      expect(stateAfterReplay.authTokenPresent).toBe(true);
      const serverSamplesAfterReplay = await observeStableLocalIdentity(runningDesktop, true);
      evidence.recordAssertionEvidence(
        "A consumed one-time grant cannot disturb the committed B identity",
        `Re-exchanging the spent grant failed while ${serverSamplesAfterReplay.length} local-server samples over ${LOCAL_SERVER_STABILITY_MS}ms kept B's policy marker and provider-sync session.`,
        true,
      );

      // Restart: the committed B enrollment is restored completely. The
      // renderer port is pinned to the first launch's port because a packaged
      // app has one fixed renderer origin — the eval harness's per-launch dev
      // port would otherwise rotate the origin that scopes localStorage.
      const rendererPort = desktop.handle.meta?.vitePort;
      if (!rendererPort) throw new Error("The first launch did not record its renderer port.");
      // Exercise a user quit, allowing Chromium to persist renderer storage,
      // before disposing the dev processes. stop() alone sends SIGINT.
      await quitDesktop(desktop);
      await desktop.stop();
      desktop = null;
      // The dev server auto-increments a busy port instead of failing, which
      // would silently rotate the renderer origin and hide the stored
      // session; wait until the first launch's port is actually released.
      await eventually(async () => !(await portInUse(Number(rendererPort))), {
        within: 60_000,
        label: `renderer port ${rendererPort} released before relaunch`,
      });
      const restarted: DesktopHandle = await relaunchDesktop({
        name: "handoff-atomic-restart",
        profileDir,
        bootstrap: { baseUrl: denB.ref.webUrl, requireSignin: false },
        env: { PORT: rendererPort },
      });
      try {
        const restartedOrigin = String(await evalIn(restarted, () => (window.location.origin)));
        if (new URL(restartedOrigin).port !== rendererPort) {
          throw new Error(
            `The relaunched renderer did not reuse port ${rendererPort} (origin ${restartedOrigin}); the restart cannot observe the persisted session.`,
          );
        }
        const stateAfterRestart = await eventually(() => readDenClientState(restarted), {
          within: 90_000,
          label: "restored B enrollment after restart",
          until: (state) => state.authTokenPresent && state.activeOrgName === ORG_B,
        });
        expect(stateAfterRestart.authTokenPresent).toBe(true);
        expect(stateAfterRestart.activeOrgName).toBe(ORG_B);
        expect(await readEnrollmentOrigin(restarted)).toBe(sessionOriginKey(denB.ref.webUrl));
        evidence.recordAssertionEvidence(
          "Restart restored the complete B enrollment",
          `After a relaunch, the app came back signed in to ${ORG_B} with the B credential and enrollment origin.`,
          true,
        );

        const anonymous = await denFetch(denB.ref, "/v1/auth/desktop-handoff", {
          method: "POST", body: JSON.stringify({}),
        });
        expect(anonymous.response.status).toBe(401);
        const credentials = {
          email: `handoff-no-org-${Date.now()}@openwork.test`,
          name: "Personal Handoff",
          password: "OpenWorkEval123!",
        };
        const signup = await denFetch(denB.ref, "/api/auth/sign-up/email", {
          method: "POST",
          body: JSON.stringify(credentials),
        });
        expect(signup.response.ok).toBe(true);
        const newcomer = await signIn(denB.ref, credentials);
        const headers = { authorization: `Bearer ${newcomer.token}` };
        const before = await denFetch(newcomer, "/v1/me/orgs", { headers });
        expect(before.response.ok).toBe(true);
        expect(before.body).toMatchObject({ orgs: [], activeOrgId: null });
        const invitation = await denFetch(denB.admin, "/v1/invitations", {
          method: "POST",
          headers: { authorization: `Bearer ${denB.admin.token}` },
          body: JSON.stringify({ email: credentials.email, role: "member" }),
        });
        expect(invitation.response.ok).toBe(true);
        const orgBefore = await denFetch(denB.admin, "/v1/org", {
          headers: { authorization: `Bearer ${denB.admin.token}` },
        });
        expect(orgBefore.response.ok).toBe(true);
        const adminBefore = await denFetch(denB.admin, "/v1/me/orgs", {
          headers: { authorization: `Bearer ${denB.admin.token}` },
        });
        expect(adminBefore.response.ok).toBe(true);

        let personalOrgId = "";
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const grant = await createDesktopHandoffGrant(newcomer);
          await control(restarted, "auth.exchange-grant", {
            grant, baseUrl: denB.ref.webUrl,
          }, { timeoutMs: 60_000 });
          const state = await eventually(() => readDenClientState(restarted), {
            within: 60_000,
            label: "org-less user enrolled with a personal organization",
            until: (value) => value.authTokenPresent && Boolean(value.activeOrgId) && value.activeOrgId !== stateB.activeOrgId,
          });
          expect(state.activeOrgId).toBeTruthy();
          if (attempt === 0) personalOrgId = state.activeOrgId ?? "";
          expect(state.activeOrgId).toBe(personalOrgId);
          const directory = await denFetch(newcomer, "/v1/me/orgs", { headers });
          expect(directory.response.ok).toBe(true);
          expect(directory.body).toMatchObject({
            orgs: [{ id: personalOrgId, role: "owner", memberCount: 1 }],
            activeOrgId: personalOrgId,
          });
          const replay = await denFetch(newcomer, "/v1/auth/desktop-handoff/exchange", {
            method: "POST", body: JSON.stringify({ grant }),
          });
          expect(replay.response.status).toBe(404);
        }
        const adminAfter = await denFetch(denB.admin, "/v1/me/orgs", {
          headers: { authorization: `Bearer ${denB.admin.token}` },
        });
        expect(adminAfter.response.ok).toBe(true);
        expect(adminAfter.body).toEqual(adminBefore.body);
        const orgAfter = await denFetch(denB.admin, "/v1/org", {
          headers: { authorization: `Bearer ${denB.admin.token}` },
        });
        expect(orgAfter.response.ok).toBe(true);
        expect(orgAfter.body).toEqual(orgBefore.body);
        const denied = await denFetch(newcomer, "/v1/org", {
          headers: { ...headers, "x-openwork-org-id": stateB.activeOrgId ?? "" },
        });
        expect(denied.response.status).toBe(404);
        evidence.recordAssertionEvidence(
          "An authenticated desktop handoff supplies a default owned organization only when membership is missing",
          "The fresh account had no organizations before handoff; desktop sign-in resolved one owned organization, a second handoff reused it, consumed grants remained unusable, and the existing organization's memberships and pending invitation were unchanged. The newcomer could not access the invited organization without accepting.",
          true,
        );

        const localServerBeforeSignOut = await eventually(() => readLocalServerIdentity(restarted), {
          within: 60_000,
          label: "B local-server identity ready before explicit sign-out",
          until: (identity) => isUsableLocalIdentity(identity, true),
        });
        expect(isUsableLocalIdentity(localServerBeforeSignOut, true)).toBe(true);
        // `settings.panel.open` is the registered product navigation action;
        // the final mutation is the real Account page's Sign out button.
        await control(restarted, "settings.panel.open", { panel: "cloud-account" });
        await clickButton(restarted, "Sign out", { timeoutMs: 60_000 });
        const signedOut = await eventually(async () => {
          const [client, localServer] = await Promise.all([
            readDenClientState(restarted),
            readLocalServerIdentity(restarted),
          ]);
          return { client, localServer };
        }, {
          within: 60_000,
          label: "explicit sign-out cleared the local-server Den session",
          until: ({ client, localServer }) => !client.authTokenPresent && isSignedOutLocalIdentity(localServer),
        });
        expect(signedOut.client.authTokenPresent).toBe(false);
        expect(isSignedOutLocalIdentity(signedOut.localServer)).toBe(true);
        evidence.recordAssertionEvidence(
          "Explicit sign-out clears account-scoped local-server state without removing stored restrictions",
          `The renderer credential is absent, provider sync reports hasSession=false, and /managed-policy returns 403 policy_unavailable because the last managed restrictions remain stored but cannot be used without a verified identity.`,
          true,
        );
      } finally {
        await restarted.stop().catch(() => undefined);
      }
    } finally {
      await desktop?.stop().catch(() => undefined);
    }
  },
);
