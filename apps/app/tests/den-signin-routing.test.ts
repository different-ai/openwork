import { describe, expect, test } from "bun:test";

import { signedInRoute } from "../src/react-app/shell/den-signin-routing";

describe("signed-in routing", () => {
  test("sends organization members directly to chat", () => {
    expect(signedInRoute("org-returning")).toBe("/session");
    expect(signedInRoute("  org-returning  ")).toBe("/session");
  });

  test("reserves onboarding for users without an organization", () => {
    expect(signedInRoute(null)).toBe("/onboarding");
    expect(signedInRoute("  ")).toBe("/onboarding");
  });
});
