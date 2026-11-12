import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { isRecord } from "../worlds/openwork-server-cli.ts";
import { STARTUP_BUDGET_MS, unreadableWorkspaceStartup } from "../worlds/unreadable-workspace-startup.ts";

const test = spec.world(unreadableWorkspaceStartup, {
  timeout: 120_000,
  resources: { surfaces: [], services: [] },
  needs: { commands: ["bun"] },
});

test("a person with one workspace folder that cannot be read can still start OpenWork and work in another folder", async ({ world, step, evidence }) => {
  await step("after: OpenWork starts even though the workspace's settings file can never be read", async () => {
    const seconds = (world.startupMs / 1000).toFixed(1);
    evidence.recordAssertionEvidence(
      "the server is listening",
      world.listening ? `listening after ${seconds} s` : `still not listening after ${STARTUP_BUDGET_MS / 1000} s`,
      world.listening,
    );
    expect(world.listening).toBe(true);
  });

  await step("then the server really was blocked on that file, and said so", async () => {
    const line = world.output().split("\n").find((entry) => entry.includes("could not be read in time")) ?? "";
    evidence.recordAssertionEvidence("the blocked read was reached", line || "no blocked-read line in the server output: the condition was not exercised", line !== "");
    expect(line).toContain("Failed to provision workspace files");
  });

  await step("the unreadable workspace says it is inaccessible at once, however many requests ask", async () => {
    const list: unknown = JSON.parse((await world.request("GET", "/workspaces")).text);
    const first: unknown = isRecord(list) && Array.isArray(list.items) ? list.items[0] : undefined;
    const id = isRecord(first) && typeof first.id === "string" ? first.id : "";
    const replies = await Promise.all(Array.from({ length: 8 }, () => world.request("GET", `/workspace/${id}/config`)));
    const slowest = Math.max(...replies.map((reply) => reply.ms));
    const ok = replies.every((reply) => reply.status === 409 && reply.text.includes("workspace_inaccessible")) && slowest < 2_000;
    evidence.recordAssertionEvidence(
      "eight requests answered without waiting on the file",
      `${replies.map((reply) => reply.status).join(" / ")}; slowest ${slowest} ms; ${replies[0]?.text.slice(0, 90)}`,
      ok,
    );
    expect(ok).toBe(true);
  });

  await step("a workspace in a readable folder is created and opens normally", async () => {
    const created = await world.request("POST", "/workspaces/local", { folderPath: world.readable, name: "Readable" });
    const body: unknown = JSON.parse(created.text);
    const id = isRecord(body) && typeof body.activeId === "string" ? body.activeId : "";
    const opened = await world.request("GET", `/workspace/${id}/config`);
    evidence.recordAssertionEvidence(
      "the readable workspace is unaffected",
      `create ${created.status} in ${created.ms} ms; open ${opened.status} in ${opened.ms} ms`,
      created.status === 201 && opened.status === 200,
    );
    expect(created.status).toBe(201);
    expect(opened.status).toBe(200);
  });
});
