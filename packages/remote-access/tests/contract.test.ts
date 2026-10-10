import { test, expect } from "vitest";
import { assertContract, normalizeBlock } from "../src/contract/index.js";
import { readFile, readdir } from "node:fs/promises";
const fixtureURL = new URL("../fixtures/normalized/", import.meta.url);
test("shared normalized fixtures satisfy the closed phone contract", async () => {
  const files = (await readdir(fixtureURL)).filter((f) => f.endsWith(".json"));
  expect(files.length).toBeGreaterThan(10);
  for (const file of files) {
    const fixture = JSON.parse(
      await readFile(new URL(file, fixtureURL), "utf8"),
    );
    expect(
      () => assertContract(fixture.type, fixture.value),
      file,
    ).not.toThrow();
  }
});
test("contract rejects accidental upstream secrets and malformed normalized states", () => {
  expect(() =>
    assertContract("WorkspaceList", [
      { id: "ws_test", name: "Synthetic", token: "secret" },
    ]),
  ).toThrow("INVALID_UPSTREAM");
  expect(() =>
    assertContract("SessionStatus", {
      phase: "finished",
      observedAt: "2026-10-08T00:00:00.000Z",
      activeTurnId: null,
      errorCode: null,
    }),
  ).toThrow("INVALID_UPSTREAM");
  expect(() =>
    assertContract("ApprovalReply", {
      requestId: "00000000-0000-4000-8000-000000000001",
      decision: "always",
      revision: "a".repeat(64),
    }),
  ).toThrow("INVALID_UPSTREAM");
  expect(
    normalizeBlock({
      type: "future",
      credential: "secret",
      html: "<script>run()</script>",
    }),
  ).toEqual({ kind: "unsupported", label: "Content available on computer" });
  expect(normalizeBlock({ type: "code", text: "x".repeat(1048577) })).toEqual({
    kind: "omitted",
    label: "Large content available on computer",
  });
});
