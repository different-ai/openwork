import { expect } from "vitest";
import {
  app,
  eventually,
  faultProxy,
  inviteMember,
  localMysqlIsRunning,
  needs,
  readConnectState,
  readDenClientState,
  server,
  test,
} from "@openwork/testkit";

const desktopConfigPath = "/api/den/v1/me/desktop-config";
const appSpecsEnabled = process.env.OPENWORK_EVAL_APP_SPECS === "1";
const localPlacement = process.env.OPENWORK_EVAL_DAYTONA !== "1" && !process.env.OPENWORK_EVAL_DEN_API_URL?.trim();
const mysqlOpen = await localMysqlIsRunning();
const title = !appSpecsEnabled
  ? "first-run bootstrap contract skipped — needs: set OPENWORK_EVAL_APP_SPECS=1"
  : !localPlacement
    ? "first-run bootstrap contract skipped — needs local placement without OPENWORK_EVAL_DEN_API_URL"
    : !mysqlOpen
      ? "first-run bootstrap contract skipped — needs MySQL on 127.0.0.1:3306"
      : "first-run handoff bootstraps Connect while desktop config is rate limited";

test.skipIf(!appSpecsEnabled || !localPlacement || !mysqlOpen)(title, async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_APP_SPECS"] });

  await using den = await server({
    place,
    org: {
      name: "First Run Bootstrap",
      admin: {
        email: `first-run-bootstrap-admin-${Date.now()}@openwork.test`,
        name: "First Run Bootstrap Admin",
        password: "OpenWorkEval123!",
      },
    },
  });
  await inviteMember(den, "member", {
    email: `first-run-bootstrap-member-${Date.now()}@openwork.test`,
    name: "First Run Bootstrap Member",
    password: "OpenWorkEval123!",
  });
  await using proxy = await faultProxy(den.ref);
  proxy.faults.status(desktopConfigPath, 429, { times: 5 });

  await using memberApp = await app({
    den: { ...den, ref: proxy.ref },
    as: "member",
    place,
  });

  const denState = await eventually(() => readDenClientState(memberApp), {
    within: 60_000,
    label: "first-run active organization",
    until: (state) => Boolean(state.activeOrgId),
  });
  expect(denState.authTokenPresent).toBe(true);
  expect(denState.activeOrgId).toBeTruthy();
  evidence.fact(
    "The handoff bootstrapped the invited member's organization",
    `The first-run profile persisted an auth token and active organization ${denState.activeOrgId}.`,
    true,
  );

  const connectState = await eventually(() => readConnectState(memberApp), {
    until: (state) => state.connectEnabled === true,
    within: 90_000,
    label: "handoff-bootstrapped Connect state",
  });
  expect(connectState.ok).toBe(true);
  evidence.fact(
    "Connect enabled from the handoff bootstrap contract",
    "The local server reported connectEnabled=true without a successful desktop-config response.",
    true,
  );

  const faultedRequests = await eventually(
    () => proxy.requests.filter((request) =>
      request.path.startsWith(desktopConfigPath) && request.status === 429 && request.faulted
    ),
    { within: 60_000, label: "faulted desktop-config request", until: (requests) => requests.length > 0 },
  );
  expect(faultedRequests.length).toBeGreaterThan(0);
  evidence.fact(
    "The desktop-config failure condition was exercised",
    `${faultedRequests.length} observed ${desktopConfigPath} request(s) received the injected HTTP 429.`,
    true,
  );
});
