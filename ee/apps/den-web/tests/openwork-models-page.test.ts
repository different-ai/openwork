import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const screen = readFileSync(
  join(import.meta.dir, "..", "app", "(den)", "dashboard", "_components", "inference-screen.tsx"),
  "utf8",
);

describe("OpenWork Models page", () => {
  test("rebuilds the screen on shared den primitives", () => {
    for (const primitive of ["DenCard", "DenBadge", "DenSectionHeader", "DenNotice", "DenButton"]) {
      expect(screen).toContain(primitive);
    }
    expect(screen).not.toContain("shadow-[0_18px_45px");
  });

  test("keeps the Stripe subscribe and enable flows", () => {
    expect(screen).toContain("Subscribe with Stripe");
    expect(screen).toContain("/v1/billing/stripe/checkout");
    expect(screen).toContain('method: "PATCH"');
    expect(screen).toContain("OpenWork Models");
  });
});
