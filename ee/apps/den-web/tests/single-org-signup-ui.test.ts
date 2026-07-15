import { afterEach, describe, expect, test } from "bun:test";
import { isSingleOrgSignupDisabled, resolveVisibleAuthMode } from "../app/(den)/_lib/auth-ui-policy";
import { EMPTY_RUNTIME_CONFIG, type DenWebRuntimeConfig } from "../app/(den)/_lib/runtime-config";
import { GET } from "../app/api/runtime-config/route";

const originalEnv = {
  DEN_API_BASE: process.env.DEN_API_BASE,
  DEN_ORG_MODE: process.env.DEN_ORG_MODE,
  DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP: process.env.DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP,
};

function restoreEnvValue(name: keyof typeof originalEnv) {
  const value = originalEnv[name];
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function readBooleanProperty(value: unknown, key: string) {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const property = Object.getOwnPropertyDescriptor(value, key)?.value;
  return typeof property === "boolean" ? property : null;
}

afterEach(() => {
  restoreEnvValue("DEN_API_BASE");
  restoreEnvValue("DEN_ORG_MODE");
  restoreEnvValue("DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP");
});

describe("single-org public signup UI policy", () => {
  test("runtime config exposes private public-signup default for single-org deployments", async () => {
    delete process.env.DEN_API_BASE;
    process.env.DEN_ORG_MODE = "single_org";
    delete process.env.DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP;

    const payload: unknown = await (await GET()).json();

    expect(readBooleanProperty(payload, "singleOrgAllowPublicSignup")).toBe(false);
  });

  test("runtime config parses Helm string public-signup values", async () => {
    delete process.env.DEN_API_BASE;
    process.env.DEN_ORG_MODE = "single_org";
    process.env.DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP = "true";

    const payload: unknown = await (await GET()).json();

    expect(readBooleanProperty(payload, "singleOrgAllowPublicSignup")).toBe(true);
  });

  test("private single-org UI resolves sign-up requests to sign-in", () => {
    const privateSingleOrgConfig: DenWebRuntimeConfig = {
      ...EMPTY_RUNTIME_CONFIG,
      orgMode: "single_org",
      singleOrgAllowPublicSignup: false,
    };

    expect(isSingleOrgSignupDisabled(privateSingleOrgConfig, true)).toBe(true);
    expect(resolveVisibleAuthMode({
      authMode: "sign-up",
      runtimeConfig: privateSingleOrgConfig,
      runtimeConfigLoaded: true,
    })).toBe("sign-in");
  });

  test("public single-org and multi-org UI can still show account creation", () => {
    const publicSingleOrgConfig: DenWebRuntimeConfig = {
      ...EMPTY_RUNTIME_CONFIG,
      orgMode: "single_org",
      singleOrgAllowPublicSignup: true,
    };
    const multiOrgConfig: DenWebRuntimeConfig = {
      ...EMPTY_RUNTIME_CONFIG,
      orgMode: "multi_org",
      singleOrgAllowPublicSignup: true,
    };

    expect(isSingleOrgSignupDisabled(publicSingleOrgConfig, true)).toBe(false);
    expect(resolveVisibleAuthMode({
      authMode: "sign-up",
      runtimeConfig: publicSingleOrgConfig,
      runtimeConfigLoaded: true,
    })).toBe("sign-up");
    expect(resolveVisibleAuthMode({
      authMode: "sign-up",
      runtimeConfig: multiOrgConfig,
      runtimeConfigLoaded: true,
    })).toBe("sign-up");
  });
});
