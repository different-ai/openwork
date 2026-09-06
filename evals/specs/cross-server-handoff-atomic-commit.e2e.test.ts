import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished } from "vitest";
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

const EVENT_RECORDER = `(() => {
  if (!window.__handoffProofEvents) {
    window.__handoffProofEvents = [];
    window.addEventListener("openwork-den-session-updated", (event) => {
      window.__handoffProofEvents.push(String(event?.detail?.status ?? "unknown"));
    });
  }
  return true;
})()`;

async function readSessionEvents(desktop: Surface): Promise<string[]> {
  const raw = await evalIn(desktop, "JSON.stringify(window.__handoffProofEvents ?? [])");
  return JSON.parse(String(raw)) as string[];
}

async function readEnrollmentOrigin(desktop: Surface): Promise<string | null> {
  const raw = await evalIn(
    desktop,
    "window.localStorage.getItem('openwork.den.sessionOrigin') ?? ''",
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

    const profileDir = await mkdtemp(join(tmpdir(), "openwork-handoff-atomic-"));
    onTestFinished(async () => {
      await chmod(profileDir, 0o755).catch(() => undefined);
      await rm(profileDir, { recursive: true, force: true });
    });

    let desktop: App | null = await app({ den: denA, as: "admin", place, profileDir });
    try {
      // The boot sign-in is itself a same-origin handoff through the same
      // transaction — its success proves same-origin handoffs still work.
      const stateA = await readDenClientState(desktop);
      expect(stateA.authTokenPresent).toBe(true);
      expect(stateA.activeOrgName).toBe(ORG_A);
      expect(await readEnrollmentOrigin(desktop)).toBe(sessionOriginKey(denA.ref.webUrl));
      evidence.recordAssertionEvidence(
        "Same-origin handoff enrolled control plane A",
        `The app signed in to ${ORG_A} with the enrollment origin stamped to A.`,
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
      evidence.recordAssertionEvidence(
        "Bootstrap persistence failure left the complete A enrollment active",
        "With bootstrap writes failing, the B handoff was rejected: the bootstrap file, token, organization, and enrollment origin all still belong to A, and no success state was published.",
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
      const stateB = await eventually(() => readDenClientState(desktop as App), {
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
      evidence.recordAssertionEvidence(
        "The retried handoff committed B atomically",
        `Origin (bootstrap file), credential, organization (${ORG_B}), and enrollment marker switched to B together.`,
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
      evidence.recordAssertionEvidence(
        "A consumed one-time grant cannot be replayed",
        "Re-exchanging the spent grant failed and the committed B enrollment was untouched.",
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
        const restartedOrigin = String(await evalIn(restarted, "window.location.origin"));
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
      } finally {
        await restarted.stop().catch(() => undefined);
      }
    } finally {
      await desktop?.stop().catch(() => undefined);
    }
  },
);
