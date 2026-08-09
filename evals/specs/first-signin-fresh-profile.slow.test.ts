import { expect } from "vitest";
import {
  app,
  eventually,
  faultProxy,
  inviteMember,
  localMysqlIsRunning,
  needs,
  readConnectState,
  readConnectStateFile,
  readDenClientState,
  server,
  test,
} from "@openwork/testkit";

const orgsPath = "/api/den/v1/me/orgs";
const appSpecsEnabled = process.env.OPENWORK_EVAL_APP_SPECS === "1";
const localPlacement = process.env.OPENWORK_EVAL_DAYTONA !== "1" && !process.env.OPENWORK_EVAL_DEN_API_URL?.trim();
const mysqlOpen = await localMysqlIsRunning();
const title = !appSpecsEnabled
  ? "fresh-profile first sign-in healing skipped — needs: set OPENWORK_EVAL_APP_SPECS=1"
  : !localPlacement
    ? "fresh-profile first sign-in healing skipped — needs local placement without OPENWORK_EVAL_DEN_API_URL"
    : !mysqlOpen
      ? "fresh-profile first sign-in healing skipped — needs MySQL on 127.0.0.1:3306"
      : "fresh-profile first sign-in heals organization and Connect state after transient faults";

test.skipIf(!appSpecsEnabled || !localPlacement || !mysqlOpen)(title, async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_APP_SPECS"] });

  await using den = await server({
    place,
    org: {
      name: "First Signin Heal",
      admin: {
        email: `first-signin-admin-${Date.now()}@openwork.test`,
        name: "First Signin Admin",
        password: "OpenWorkEval123!",
      },
    },
  });
  await inviteMember(den, "fresh", {
    email: `first-signin-member-${Date.now()}@openwork.test`,
    name: "Fresh Profile Member",
    password: "OpenWorkEval123!",
  });
  await using proxy = await faultProxy(den.ref);
  proxy.faults.status(orgsPath, 429, { times: 3 });

  await using freshApp = await app({
    den: { ...den, ref: proxy.ref },
    as: "fresh",
    place,
    localServerDelayMs: 3_000,
  });

  const denState = await eventually(() => readDenClientState(freshApp), {
    within: 60_000,
    label: "fresh profile active organization",
    until: (state) => Boolean(state.activeOrgId),
  });
  expect(denState.authTokenPresent).toBe(true);
  expect(denState.activeOrgId).toBeTruthy();
  evidence.fact(
    "The fresh profile converged on an active organization",
    `The handoff persisted an auth token and active organization ${denState.activeOrgId}.`,
    true,
  );

  const connectState = await eventually(() => readConnectState(freshApp), {
    within: 90_000,
    label: "local server Connect state",
    until: (state) => state.connectEnabled === true,
  });
  expect(connectState.ok).toBe(true);
  evidence.fact(
    "Connect converged after the delayed local server start",
    "The authenticated local-server state endpoint reported connectEnabled=true.",
    true,
  );

  if (freshApp.handle.hostKind === "local") {
    const fileState = await eventually(() => readConnectStateFile(freshApp), {
      within: 30_000,
      label: "persisted Connect state file",
      until: (state) => state.status === "available" && state.connectEnabled === true,
    });
    expect(fileState).toEqual({ status: "available", connectEnabled: true });
    evidence.fact(
      "Connect persisted to the fresh profile",
      "The profile's connect-state.json reports connectEnabled=true.",
      true,
    );
  }

  const faultedRequests = await eventually(
    () => proxy.requests.filter((request) => request.path.startsWith(orgsPath) && request.status === 429 && request.faulted),
    { within: 60_000, label: "faulted organization request", until: (requests) => requests.length > 0 },
  );
  expect(faultedRequests.length).toBeGreaterThan(0);
  evidence.fact(
    "The organization request fault burst was exercised",
    `${faultedRequests.length} observed ${orgsPath} request(s) received the injected HTTP 429.`,
    true,
  );
});
