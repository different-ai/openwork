import path from "node:path";
import { expect } from "vitest";
import { test } from "@openwork/testkit";

import { buildHeadlessServerLaunch } from "../../scripts/dev-headless-web-lib";

test("headless web development launches the server from current source", ({ evidence }) => {
  const launch = buildHeadlessServerLaunch("/repo/openwork", ["--port", "8787"]);

  expect(launch).toEqual({
    command: "bun",
    args: [
      "--conditions=development",
      path.join("/repo/openwork", "apps/server/src/cli.ts"),
      "--port",
      "8787",
    ],
  });
  expect(launch.args.join(" ")).not.toContain("apps/server/dist");
  expect(launch.args.join(" ")).not.toContain("openwork-server");

  evidence.recordAssertionEvidence(
    "Local headless development is source-first",
    "The launch command executes apps/server/src/cli.ts and never references compiled server output, so a stale dist binary cannot affect a restarted development stack.",
    true,
  );
});
