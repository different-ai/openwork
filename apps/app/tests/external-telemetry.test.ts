import { expect, test } from "bun:test";
import { externalTelemetryAllowed } from "../src/app/lib/enterprise-activation";

test("the public and Cloud builds may send analytics and error reports", () => {
  expect(externalTelemetryAllowed({ flavor: "public" })).toBe(true);
  expect(externalTelemetryAllowed({ flavor: "cloud" })).toBe(true);
});

test("an OpenWork Enterprise build never sends", () => {
  expect(externalTelemetryAllowed({ flavor: "enterprise" })).toBe(false);
});
