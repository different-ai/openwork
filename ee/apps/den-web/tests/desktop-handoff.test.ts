import { expect, test } from "bun:test";
import { getDesktopGrant } from "../app/(den)/_lib/desktop-handoff";

test("extracts a one-time grant from an Micx desktop handoff", () => {
  expect(
    getDesktopGrant(
      "micx://den-auth?grant=one-time-code&baseUrl=https%3A%2F%2Fapi.example.test"
    )
  ).toBe("one-time-code");
});

test("rejects missing and malformed desktop handoffs", () => {
  expect(
    getDesktopGrant(
      "micx://den-auth?baseUrl=https%3A%2F%2Fapi.example.test"
    )
  ).toBeNull();
  expect(getDesktopGrant("not a url")).toBeNull();
  expect(getDesktopGrant(null)).toBeNull();
});
