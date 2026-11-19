import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { lintSource, rules, type Rule } from "./lint.ts";

const fixtures = new URL("./fixtures/", import.meta.url);

function fixture(path: string): { file: string; text: string } {
  const raw = readFileSync(new URL(path, fixtures), "utf8");
  const [header = "", ...rest] = raw.split("\n");
  const file = /^\/\/ path: (.+)$/.exec(header)?.[1];
  if (!file) throw new Error(`${path} must start with "// path: <folder>/<file>"`);
  return { file, text: rest.join("\n") };
}

function cases(rule: Rule): string[] {
  return readdirSync(new URL(`${rule}/`, fixtures)).map((name) => `${rule}/${name}`);
}

describe("spec-lint", () => {
  test.each(rules.flatMap((rule) => cases(rule).map((path): [Rule, string] => [rule, path])))("spec/%s fires on %s", (rule, path) => {
    const { file, text } = fixture(path);
    expect(lintSource(file, text).map((violation) => violation.rule)).toContain(rule);
  });

  test.each(["clean/core.txt", "clean/proof.txt"])("%s passes every rule", (path) => {
    const { file, text } = fixture(path);
    expect(lintSource(file, text)).toEqual([]);
  });

  test("an unlisted core journey is pointed at the proofs folder and the existing journeys", () => {
    const { file, text } = fixture("allowed-files/unlisted-core-journey.txt");
    const message = lintSource(file, text).find((violation) => violation.rule === "allowed-files")?.message ?? "";
    expect(message).toContain("evals/proofs/<name>.proof.test.ts");
    expect(message).toContain("core-chat (");
  });
});
