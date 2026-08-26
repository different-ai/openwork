import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import { needs, server, test } from "@openwork/testkit";

const requirements = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readDashboardAvailability(
  den: Awaited<ReturnType<typeof server>>,
): Promise<unknown> {
  const config = await denFetch(den.admin, "/v1/me/desktop-config", {
    headers: { authorization: `Bearer ${den.admin.token}` },
  });
  expect(config.response.status, config.text).toBe(200);
  return isRecord(config.body) ? config.body.dashboardEnabled : undefined;
}

test("Den advertises fail-closed Dashboard deployment availability", { timeout: 300_000 }, async ({ evidence, place }) => {
  needs(requirements);

  await using disabledDen = await server({
    place,
    env: { DEN_DASHBOARDS_ENABLED: "false" },
  });
  expect(await readDashboardAvailability(disabledDen)).toBe(false);

  await using enabledDen = await server({
    place,
    env: { DEN_DASHBOARDS_ENABLED: "true" },
  });
  expect(await readDashboardAvailability(enabledDen)).toBe(true);

  evidence.recordAssertionEvidence(
    "Den advertises explicit Dashboard deployment availability",
    "The Desktop config endpoint returned dashboardEnabled=false for a disabled deployment and dashboardEnabled=true only after the Den flag was explicitly enabled.",
    true,
  );
});
