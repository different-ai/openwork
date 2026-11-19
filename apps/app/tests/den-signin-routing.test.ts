import { describe, expect, test } from "bun:test";
import {
  resolveDenSigninRedirect,
  shouldRenderPreparedRedirect,
  type DenSigninRouteInput,
} from "../src/react-app/shell/den-signin-routing";

const base: DenSigninRouteInput = {
  authChecking: false,
  isSignedIn: false,
  requireSignin: false,
  hasPreparedBootstrap: false,
  onSignin: false,
  onOnboarding: false,
  orgSelectionPending: false,
};

function route(overrides: Partial<DenSigninRouteInput>) {
  return resolveDenSigninRedirect({ ...base, ...overrides });
}

describe("den sign-in gate routing", () => {
  test("waits for the first auth check", () => {
    expect(route({ authChecking: true, requireSignin: true })).toBeNull();
  });

  test("forced sign-in still holds an unprepared, signed-out desktop at /signin", () => {
    expect(route({ requireSignin: true })).toBe("/signin");
    expect(route({ requireSignin: true, onOnboarding: true })).toBe("/signin");
    expect(route({ requireSignin: true, onSignin: true })).toBeNull();
  });

  test("forced sign-in shows a prepared, signed-out desktop its Setup complete page", () => {
    const prepared = { requireSignin: true, hasPreparedBootstrap: true };
    expect(route(prepared)).toBe("/onboarding");
    expect(route({ ...prepared, onOnboarding: true })).toBeNull();
    expect(shouldRenderPreparedRedirect({ ...base, ...prepared })).toBe(true);
  });

  test("a prepared desktop can still choose to sign in with an existing account", () => {
    expect(route({ requireSignin: true, hasPreparedBootstrap: true, onSignin: true })).toBeNull();
    expect(route({ hasPreparedBootstrap: true, onSignin: true })).toBeNull();
    expect(shouldRenderPreparedRedirect({ ...base, requireSignin: true, hasPreparedBootstrap: true, onSignin: true })).toBe(false);
  });

  test("a signed-in user leaves /signin for their signed-in home", () => {
    expect(route({ requireSignin: true, isSignedIn: true, onSignin: true })).toBe("signed-in-home");
    expect(route({ requireSignin: true, isSignedIn: true, hasPreparedBootstrap: true })).toBeNull();
    expect(route({ isSignedIn: true, onSignin: true })).toBe("/session");
  });

  test("optional sign-in keeps the existing routing", () => {
    expect(route({ onSignin: true })).toBe("/session");
    expect(route({ hasPreparedBootstrap: true })).toBe("/onboarding");
    expect(route({ onOnboarding: true })).toBe("/session");
    expect(route({ isSignedIn: true, orgSelectionPending: true })).toBe("/onboarding");
    expect(route({ isSignedIn: true })).toBeNull();
  });
});
