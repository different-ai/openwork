import { expect, test } from "vitest";
import { createFakeProvider } from "@openwork/sandbox/testing";
import { SandboxError } from "@openwork/sandbox";
import { sharedDaytonaExec, worldDaytonaAuth } from "./sandbox-daytona.ts";

test("scoped key plus URL has priority and never reads saved credentials", async () => {
  const auth = await worldDaytonaAuth({ DAYTONA_API_KEY: "test-key", DAYTONA_API_URL: "https://example.com/api" }, async () => { throw new Error("must not read"); });
  expect(auth).toEqual({ mode: "api-key", apiKey: "test-key", apiUrl: "https://example.com/api" });
});
test("active CLI identity is preserved when no scoped key+URL was supplied", async () => {
  const profile = JSON.stringify({ activeProfile: "profile", profiles: [{ id: "profile", api: { url: "https://example.com/api", token: "test-session" }, activeOrganizationId: "test-org" }] });
  expect(await worldDaytonaAuth({ DAYTONA_API_KEY: "ignored-without-url" }, async () => profile)).toEqual({ mode: "cli" });
});
test("create/run/delete go through the shared blocks and owned-instance guard", async () => {
  const p = createFakeProvider({ onRun: () => ({ exitCode: 0, stdout: "exact", stderr: "" }) });
  const exec = sharedDaytonaExec(p, async id => ({ id, public: false, toolboxProxyUrl: "https://example.com/toolbox" }), async () => { throw new Error("unexpected CLI fallback"); });
  const created = await exec(["create", "--name", "test-world", "--snapshot", "test", "--auto-stop", "0"]);
  expect(created.code).toBe(0);
  const result = await exec(["exec", created.stdout, "--", "echo exact"]);
  expect(result.stdout).toBe("exact");
  await expect(exec(["delete", "unowned"])).rejects.toThrow(/not created/);
  await exec(["delete", created.stdout]);
  expect(await p.get({ providerId: p.id, ref: { sandboxId: created.stdout } })).toBeNull();
});
test("unknown command outcomes throw instead of entering checkedExec retries", async () => {
  let calls = 0;
  const p = createFakeProvider({ onRun: () => { calls++; throw new SandboxError({ providerId: "fake", code: "timeout", retryable: false, message: "unknown" }); } });
  const exec = sharedDaytonaExec(p, async id => ({ id }));
  const created = await exec(["create", "--name", "test-world", "--snapshot", "test"]);
  await expect(exec(["exec", created.stdout, "--", "side effect"])).rejects.toThrow(/unknown/);
  expect(calls).toBe(1);
  await exec(["delete", created.stdout]);
});
