import { expect } from "vitest";
import {
  app,
  eventually,
  inviteMember,
  localMysqlIsRunning,
  needs,
  readConnectState,
  server,
  test,
} from "@openwork/testkit";

const appSpecsEnabled = process.env.OPENWORK_EVAL_APP_SPECS === "1";
const localPlacement = process.env.OPENWORK_EVAL_DAYTONA !== "1" && !process.env.OPENWORK_EVAL_DEN_API_URL?.trim();
const mysqlOpen = await localMysqlIsRunning();
const title = !appSpecsEnabled
  ? "Connect state provenance skipped — needs: set OPENWORK_EVAL_APP_SPECS=1"
  : !localPlacement
    ? "Connect state provenance skipped — needs local placement without OPENWORK_EVAL_DEN_API_URL"
    : !mysqlOpen
      ? "Connect state provenance skipped — needs MySQL on 127.0.0.1:3306"
      : "fresh-profile Connect state distinguishes not configured from explicit organization policy";

test.skipIf(!appSpecsEnabled || !localPlacement || !mysqlOpen)(title, async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_APP_SPECS"] });

  await using den = await server({
    place,
    org: {
      name: "Connect State Provenance",
      admin: {
        email: `connect-state-admin-${Date.now()}@openwork.test`,
        name: "Connect State Admin",
        password: "OpenWorkEval123!",
      },
    },
  });
  await inviteMember(den, "fresh", {
    email: `connect-state-member-${Date.now()}@openwork.test`,
    name: "Fresh Profile Member",
    password: "OpenWorkEval123!",
  });
  await using freshApp = await app({
    den,
    as: "fresh",
    place,
    beforeSignIn: async (surface) => {
      const initialState = await eventually(() => readConnectState(surface), {
        within: 15_000,
        label: "fresh-profile Connect provenance",
        until: (state) => state.ok && state.status === "missing",
      });
      expect(initialState.status).toBe("missing");
      expect(initialState.connectEnabled).toBe(false);
      evidence.fact(
        "The fresh profile reports Connect as not configured",
        "Before sign-in, the local-server state endpoint reported status=missing while no policy had been learned.",
        true,
      );
      expect(initialState.status).not.toBe("available");
      evidence.fact(
        "The fresh profile is not reported as explicitly disabled",
        "The false compatibility value was paired with status=missing, not status=available.",
        initialState.status !== "available",
      );
    },
  });

  const policyState = await eventually(() => readConnectState(freshApp), {
    within: 60_000,
    label: "explicit Connect organization policy",
    until: (state) => state.ok && state.status === "available" && state.connectEnabled === true,
  });
  expect(policyState.status).toBe("available");
  expect(policyState.connectEnabled).toBe(true);
  evidence.fact(
    "Sign-in delivers an explicit Connect policy",
    "After sign-in, the endpoint reported status=available and connectEnabled=true.",
    true,
  );
});
