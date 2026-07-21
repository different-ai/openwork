import { describe, expect, test } from "bun:test";
import { resolveReauthMethods } from "../app/(den)/_lib/reauth-method-policy";

describe("reauthentication method policy", () => {
  test("offers only organization SSO when an SSO requirement is resolved", () => {
    expect(resolveReauthMethods({
      providers: ["google", "email"],
      loading: false,
      requiresSso: true,
    })).toEqual({
      hasPassword: false,
      socialProviders: [],
    });
  });

  test("does not expose a social provider before SSO resolution completes", () => {
    expect(resolveReauthMethods({
      providers: ["google"],
      loading: true,
      requiresSso: false,
    })).toEqual({
      hasPassword: false,
      socialProviders: [],
    });
  });

  test("preserves linked methods when organization SSO is not required", () => {
    expect(resolveReauthMethods({
      providers: ["google", "email"],
      loading: false,
      requiresSso: false,
    })).toEqual({
      hasPassword: true,
      socialProviders: ["google"],
    });
  });
});
