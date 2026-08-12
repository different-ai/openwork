import { expect } from "vitest";
import { app, eventually, inviteMember, needs, readDenClientState, server, test } from "@openwork/testkit";
import { waitUntilInteractive } from "@openwork/behaviors";
import { NETWORK_PROFILES, isInteractive, throttleNetwork } from "@openwork/cdp";
import type { ThrottledNetwork } from "@openwork/cdp";
import { daytonaSandbox } from "@openwork/hosts";

const sandboxA = process.env.OPENWORK_EVAL_DAYTONA_SANDBOX_A?.trim();
const sandboxB = process.env.OPENWORK_EVAL_DAYTONA_SANDBOX_B?.trim();
const appSpecsEnabled = process.env.OPENWORK_EVAL_APP_SPECS === "1";
const distinctSandboxes = Boolean(sandboxA && sandboxB && sandboxA !== sandboxB);
const enabled = appSpecsEnabled && distinctSandboxes;

const title = !appSpecsEnabled
  ? "invited members on a degraded network skipped — needs: set OPENWORK_EVAL_APP_SPECS=1"
  : !distinctSandboxes
    ? "invited members on a degraded network skipped — needs: two distinct OPENWORK_EVAL_DAYTONA_SANDBOX_A/_B"
    : "invited members reach their workspace from two sandboxes, one of them on slow 3G";

/**
 * Two people accept an invite to the same organization from two different
 * machines, and one of them is on bad wifi. That second case is the one the
 * harness could not reach before: HTTP faults could break a Den call outright,
 * but not make every call merely slow, which is what a real bad network does.
 */
test.skipIf(!enabled)(title, async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_APP_SPECS"] });
  if (!sandboxA || !sandboxB) throw new Error("Set OPENWORK_EVAL_DAYTONA_SANDBOX_A and OPENWORK_EVAL_DAYTONA_SANDBOX_B.");

  await using den = await server({ place });
  const stamp = Date.now();
  await inviteMember(den, "slow", {
    email: `slow-network-member-${stamp}@openwork.test`,
    name: "Slow Network Member",
    password: "OpenWorkEval123!",
  });
  await inviteMember(den, "steady", {
    email: `steady-network-member-${stamp}@openwork.test`,
    name: "Steady Network Member",
    password: "OpenWorkEval123!",
  });

  // Throttle before the grant exchange rather than after it, so the sign-in
  // itself happens on the degraded network instead of only what follows.
  const degraded: ThrottledNetwork[] = [];
  await using slowApp = await app({
    den,
    as: "slow",
    place,
    host: daytonaSandbox(sandboxA),
    beforeSignIn: async (surface) => {
      degraded.push(await throttleNetwork(surface, "slow-3g"));
    },
  });
  expect(degraded).toHaveLength(1);
  evidence.fact(
    "The invited member signed in with the app held on slow 3G",
    `Sign-in ran with ${NETWORK_PROFILES["slow-3g"].latencyMs}ms added latency and a ${NETWORK_PROFILES["slow-3g"].downloadBps} B/s download ceiling.`,
    true,
  );

  const slowState = await eventually(() => readDenClientState(slowApp), {
    within: 120_000,
    label: "slow-network active organization",
    until: (state) => Boolean(state.activeOrgId),
  });
  expect(slowState.authTokenPresent).toBe(true);
  expect(slowState.activeOrgId).toBeTruthy();
  evidence.fact(
    "A degraded network still produced a usable organization",
    `The throttled desktop holds an auth token and active organization ${slowState.activeOrgId}.`,
    true,
  );

  for (const throttled of degraded) await throttled.restore();

  await using steadyApp = await app({ den, as: "steady", place, host: daytonaSandbox(sandboxB) });

  expect(slowApp.handle.sandboxId).toBe(sandboxA);
  expect(steadyApp.handle.sandboxId).toBe(sandboxB);
  expect(slowApp.workspaceId).toBeTruthy();
  expect(steadyApp.workspaceId).toBeTruthy();
  evidence.fact(
    "Both members reached a workspace from separate sandboxes",
    `Workspace ${slowApp.workspaceId} on ${sandboxA} and workspace ${steadyApp.workspaceId} on ${sandboxB}, against one Den.`,
    true,
  );

  const [slowSurface, steadySurface] = await Promise.all([
    waitUntilInteractive(slowApp, { timeoutMs: 120_000 }),
    waitUntilInteractive(steadyApp, { timeoutMs: 120_000 }),
  ]);
  expect(isInteractive(slowSurface)).toBe(true);
  expect(isInteractive(steadySurface)).toBe(true);
  evidence.fact(
    "Both desktops finished on an interactive surface",
    "Neither app was left on a transitional screen once the network recovered.",
    true,
  );
});
