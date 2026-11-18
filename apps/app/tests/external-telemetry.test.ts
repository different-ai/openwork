import { expect, test } from "bun:test";
import { externalTelemetryAllowed } from "../src/app/lib/enterprise-activation";

test("only a non-Enterprise install on OpenWork Cloud may send analytics or error reports", () => {
  expect(externalTelemetryAllowed({ flavor: "public", selfHostedControlPlane: false })).toBe(true);
  expect(externalTelemetryAllowed({ flavor: "cloud", selfHostedControlPlane: false })).toBe(true);
});

test("an OpenWork Enterprise install never sends, even when pointed at OpenWork Cloud", () => {
  expect(externalTelemetryAllowed({ flavor: "enterprise", selfHostedControlPlane: false })).toBe(false);
  expect(externalTelemetryAllowed({ flavor: "enterprise", selfHostedControlPlane: true })).toBe(false);
});

test("any install signed in to an organization's own server never sends", () => {
  expect(externalTelemetryAllowed({ flavor: "public", selfHostedControlPlane: true })).toBe(false);
  expect(externalTelemetryAllowed({ flavor: "cloud", selfHostedControlPlane: true })).toBe(false);
});
