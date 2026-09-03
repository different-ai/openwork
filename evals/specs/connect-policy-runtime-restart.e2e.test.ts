import { rm } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { evalIn } from "@openwork/behaviors";
import { electronProfilePaths } from "@openwork/hosts";
import {
  app,
  eventually,
  inviteMember,
  localMysqlIsRunning,
  needs,
  readConnectState,
  readConnectStateFile,
  server,
  test,
} from "@openwork/testkit";

type RuntimeGeneration = {
  running: boolean;
  baseUrl: string;
  generation: number | null;
};

// Reads the live local-server lifetime identity from the desktop bridge.
// Ports and tokens are sticky across restarts, so the monotonic per-start
// generation is the observable identity of one server lifetime.
async function readRuntimeGeneration(surface: Parameters<typeof evalIn>[0]): Promise<RuntimeGeneration> {
  const value = await evalIn(surface, `(async () => {
    const invokeDesktop = window.__OPENWORK_ELECTRON__ && window.__OPENWORK_ELECTRON__.invokeDesktop;
    if (!invokeDesktop) return { running: false, baseUrl: "", generation: null };
    try {
      const info = await invokeDesktop("openworkServerInfo");
      return {
        running: Boolean(info && info.running === true),
        baseUrl: String((info && info.baseUrl) ?? "").trim(),
        generation: info && typeof info.generation === "number" ? info.generation : null,
      };
    } catch {
      return { running: false, baseUrl: "", generation: null };
    }
  })()`, { awaitPromise: true, timeoutMs: 15_000 });
  const record = value as Partial<RuntimeGeneration> | null;
  return {
    running: record?.running === true,
    baseUrl: typeof record?.baseUrl === "string" ? record.baseUrl : "",
    generation: typeof record?.generation === "number" ? record.generation : null,
  };
}

const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const localPlacement = process.env.OPENWORK_EVAL_DAYTONA !== "1" && !process.env.OPENWORK_EVAL_DEN_API_URL?.trim();
const mysqlOpen = await localMysqlIsRunning();
const title = !e2eTestsEnabled
  ? "Connect policy runtime convergence skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1"
  : !localPlacement
    ? "Connect policy runtime convergence skipped — needs local placement without OPENWORK_EVAL_DEN_API_URL"
    : !mysqlOpen
      ? "Connect policy runtime convergence skipped — needs MySQL on 127.0.0.1:3306"
      : "Connect policy converges on a slow-starting runtime and is reapplied to the next runtime generation";

test.skipIf(!e2eTestsEnabled || !localPlacement || !mysqlOpen)(title, async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });

  await using den = await server({
    place,
    org: {
      name: "Connect Policy Convergence",
      admin: {
        email: `connect-policy-admin-${Date.now()}@openwork.test`,
        name: "Connect Policy Admin",
        password: "OpenWorkEval123!",
      },
    },
  });
  await inviteMember(den, "fresh", {
    email: `connect-policy-member-${Date.now()}@openwork.test`,
    name: "Fresh Profile Member",
    password: "OpenWorkEval123!",
  });

  // The local server publishes readiness only after a deliberate delay, so the
  // organization policy is known to the app before the runtime target exists.
  await using desktopApp = await app({
    den,
    as: "fresh",
    place,
    localServerDelayMs: 5_000,
    beforeSignIn: async (surface) => {
      const preSignInState = await eventually(() => readConnectState(surface), {
        within: 15_000,
        label: "fresh-profile Connect state before sign-in",
        until: (state) => state.ok && state.status === "missing",
      });
      expect(preSignInState.status).toBe("missing");
      expect(preSignInState.connectEnabled).toBe(false);
      expect(preSignInState.status).not.toBe("available");
      evidence.recordAssertionEvidence(
        "Before sign-in, Connect is missing rather than explicitly disabled",
        "The fresh profile reported status=missing and connectEnabled=false, not status=available.",
        preSignInState.status === "missing" && preSignInState.connectEnabled === false,
      );
    },
  });

  const initialState = await eventually(() => readConnectState(desktopApp), {
    within: 90_000,
    label: "Connect policy convergence on the delayed runtime",
    until: (state) => state.ok && state.status === "available" && state.connectEnabled === true,
  });
  expect(initialState.status).toBe("available");
  expect(initialState.connectEnabled).toBe(true);
  evidence.recordAssertionEvidence(
    "The organization Connect policy converged on a slow-starting runtime",
    "Although the local server delayed its readiness past the policy arrival, the state endpoint reported status=available and connectEnabled=true.",
    true,
  );

  const firstGeneration = await readRuntimeGeneration(desktopApp);
  expect(firstGeneration.running).toBe(true);
  expect(firstGeneration.baseUrl.length).toBeGreaterThan(0);
  expect(firstGeneration.generation).not.toBeNull();

  if (desktopApp.handle.hostKind !== "local" || !desktopApp.handle.profileDir) {
    throw new Error("This spec drives the local desktop profile and requires a local app with a profile directory.");
  }
  // Remove the persisted Connect state so post-restart convergence cannot be
  // explained by on-disk persistence: only a reapplication to the new runtime
  // generation can restore it.
  const paths = electronProfilePaths(desktopApp.handle.profileDir);
  const stateFileCandidates = [
    join(paths.userDataDir, "openwork-dev-data", "xdg", "config", "openwork", "connect-state.json"),
    join(paths.configHome, "openwork", "connect-state.json"),
    join(paths.homeDir, ".config", "openwork", "connect-state.json"),
  ];
  for (const candidate of stateFileCandidates) {
    await rm(candidate, { force: true });
  }
  const clearedFile = await readConnectStateFile(desktopApp);
  expect(clearedFile.status).toBe("missing");
  evidence.recordAssertionEvidence(
    "The persisted Connect state was cleared before the restart",
    "connect-state.json reports missing, so any post-restart Connect state must come from a fresh policy application, not persistence.",
    true,
  );

  // Restart the local server through the same runtime path every product
  // restart uses, followed by the runtime-change observation those paths
  // dispatch after republishing the server connection.
  const restarted = await evalIn(desktopApp, `(async () => {
    const invokeDesktop = window.__OPENWORK_ELECTRON__ && window.__OPENWORK_ELECTRON__.invokeDesktop;
    if (!invokeDesktop) return false;
    const info = await invokeDesktop("openworkServerRestart", {});
    window.dispatchEvent(new CustomEvent("openwork-server-settings-changed"));
    return Boolean(info && info.running === true);
  })()`, { awaitPromise: true, timeoutMs: 60_000 });
  expect(restarted).toBe(true);

  const secondGeneration = await eventually(() => readRuntimeGeneration(desktopApp), {
    within: 30_000,
    label: "new runtime generation after restart",
    until: (generation) =>
      generation.running &&
      generation.baseUrl.length > 0 &&
      generation.generation !== null &&
      generation.generation !== firstGeneration.generation,
  });
  expect(secondGeneration.generation).not.toBeNull();
  expect(secondGeneration.generation).not.toBe(firstGeneration.generation);
  evidence.recordAssertionEvidence(
    "The restart produced a new runtime generation",
    `The restarted local server reported per-start generation ${secondGeneration.generation} where the previous lifetime reported ${firstGeneration.generation}.`,
    true,
  );

  const reappliedState = await eventually(() => readConnectState(desktopApp), {
    within: 90_000,
    label: "Connect policy reapplication on the new runtime generation",
    until: (state) => state.ok && state.status === "available" && state.connectEnabled === true,
  });
  expect(reappliedState.status).toBe("available");
  expect(reappliedState.connectEnabled).toBe(true);
  evidence.recordAssertionEvidence(
    "The unchanged policy was reapplied to the new runtime generation",
    "With persistence cleared, the restarted server reached status=available and connectEnabled=true again — the desired organization policy was re-delivered to the new generation.",
    true,
  );

  const persistedAgain = await eventually(() => readConnectStateFile(desktopApp), {
    within: 30_000,
    label: "reapplied Connect state persisted",
    until: (state) => state.status === "available" && state.connectEnabled === true,
  });
  expect(persistedAgain).toEqual({ status: "available", connectEnabled: true });
  evidence.recordAssertionEvidence(
    "The reapplied policy persisted to the profile",
    "connect-state.json reports connectEnabled=true again after the reapplication.",
    true,
  );
});
