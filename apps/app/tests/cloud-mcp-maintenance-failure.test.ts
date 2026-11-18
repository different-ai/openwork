import { expect, test } from "bun:test";
import { DenApiError } from "../src/app/lib/den.ts";
import { OpenworkServerError } from "../src/app/lib/openwork-server.ts";
import { cloudMcpMaintenanceFailure } from "../src/react-app/domains/connections/use-session-mcp-maintenance.ts";

test("connected-tools maintenance stops retrying when this computer's disk is full", () => {
  const full = cloudMcpMaintenanceFailure(new OpenworkServerError(507, "insufficient_storage", "Not enough disk space. Free up space on the computer running OpenWork, then try again."));
  expect(full.outcome).toBe("failed");
  if (full.outcome !== "failed") return;
  expect(full.issue).toMatchObject({
    code: "insufficient_storage",
    retryable: false,
    recommendedAction: "Free up disk space on this computer, then try again.",
    message: "Not enough disk space. Free up space on the computer running OpenWork, then try again.",
  });
});

test("other maintenance failures keep their retries and their advice", () => {
  const server = cloudMcpMaintenanceFailure(new OpenworkServerError(500, "internal_error", "Unexpected server error"));
  expect(server.outcome === "failed" && server.issue.retryable).toBe(true);
  expect(server.outcome === "failed" && server.issue.recommendedAction).toBe("Retry, then open Settings → Connect if the problem continues.");
  // A storage error from Den is another machine's disk, so nothing changes for it.
  const den = cloudMcpMaintenanceFailure(new DenApiError(507, "insufficient_storage", "Storage is full"));
  expect(den.outcome === "failed" && den.issue.retryable).toBe(true);
  // A request the server never answered is still worth another try.
  const unknown = cloudMcpMaintenanceFailure(new Error("network down"));
  expect(unknown.outcome === "failed" && unknown.issue.retryable).toBe(true);
});
