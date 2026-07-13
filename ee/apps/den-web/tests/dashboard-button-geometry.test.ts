import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const buttonPath = fileURLToPath(
  new URL("../app/(den)/_components/ui/button.tsx", import.meta.url),
);

describe("dashboard button geometry", () => {
  test("shared action primitives use softly rounded rectangles", () => {
    const source = readFileSync(buttonPath, "utf8");

    expect(source).toContain("rounded-lg");
    expect(source).not.toContain("rounded-full");
  });
});
