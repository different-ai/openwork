import { describe, expect, test } from "bun:test";
import { parseOrgScimPayload } from "../app/(den)/_lib/den-org";

describe("SCIM SSO readiness", () => {
  test("defaults to blocked unless the API confirms SSO is ready", () => {
    expect(parseOrgScimPayload({}).ssoReady).toBe(false);
    expect(parseOrgScimPayload({ ssoReady: false }).ssoReady).toBe(false);
    expect(parseOrgScimPayload({ ssoReady: true }).ssoReady).toBe(true);
  });
});
