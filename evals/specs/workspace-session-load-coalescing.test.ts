import { expect } from "vitest";
import { test } from "@openwork/testkit";

import { createRouteWorkspaceLoadCoalescer } from "../../apps/app/src/react-app/shell/route-refresh-control";

test("workspace session refreshes share an unsettled load", async ({ evidence }) => {
  const coalescer = createRouteWorkspaceLoadCoalescer();
  const starts: string[] = [];
  let release: (() => void) | undefined;

  const first = coalescer.run("workspace-a", async () => {
    starts.push("workspace-a");
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const overlappingRefresh = coalescer.run("workspace-a", async () => {
    starts.push("workspace-a-overlap");
  });
  const independentWorkspace = coalescer.run("workspace-b", async () => {
    starts.push("workspace-b");
  });

  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(overlappingRefresh).toBe(first);
  expect(starts).toEqual(["workspace-a", "workspace-b"]);
  expect(coalescer.isInFlight("workspace-a")).toBe(true);

  release?.();
  await Promise.all([first, overlappingRefresh, independentWorkspace]);
  expect(coalescer.isInFlight("workspace-a")).toBe(false);

  evidence.recordAssertionEvidence(
    "An overlapping refresh cannot duplicate a workspace session load",
    "Two refresh callers shared one unsettled workspace-a load while workspace-b remained independent.",
    starts.join(",") === "workspace-a,workspace-b",
  );
});
