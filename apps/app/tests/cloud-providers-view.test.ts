import { describe, expect, test } from "bun:test";

import {
  canRetryCloudProviderRow,
  resolveCloudProviderRowStatus,
  type CloudProviderRowStateInput,
} from "../src/react-app/domains/settings/pages/cloud-providers-view";

const ready: CloudProviderRowStateInput = {
  imported: true,
  outOfSync: false,
  allowed: true,
  importsUnavailable: false,
  needsCredential: false,
  needsServer: false,
  syncError: null,
};

describe("Cloud provider status-only rows", () => {
  test("shows connected and syncing states from the import baseline", () => {
    expect(resolveCloudProviderRowStatus(ready)).toBe("connected");
    expect(resolveCloudProviderRowStatus({ ...ready, imported: false })).toBe("syncing");
    expect(resolveCloudProviderRowStatus({ ...ready, outOfSync: true })).toBe("syncing");
  });

  test("shows policy and workspace gates without retrying", () => {
    const blocked = resolveCloudProviderRowStatus({ ...ready, allowed: false });
    const unavailable = resolveCloudProviderRowStatus({ ...ready, importsUnavailable: true });
    expect(blocked).toBe("blocked");
    expect(unavailable).toBe("unavailable");
    expect(canRetryCloudProviderRow(blocked)).toBe(false);
    expect(canRetryCloudProviderRow(unavailable)).toBe(false);
  });

  test("renders credential, server, and generic sync errors with retry only for generic errors", () => {
    const needsCredential = resolveCloudProviderRowStatus({
      ...ready,
      needsCredential: true,
    });
    const needsServer = resolveCloudProviderRowStatus({
      ...ready,
      needsServer: true,
    });
    const error = resolveCloudProviderRowStatus({
      ...ready,
      syncError: { kind: "error", message: "Network failed" },
    });
    expect(needsCredential).toBe("needs_credential");
    expect(needsServer).toBe("needs_server");
    expect(error).toBe("error");
    expect(canRetryCloudProviderRow(needsCredential)).toBe(false);
    expect(canRetryCloudProviderRow(needsServer)).toBe(false);
    expect(canRetryCloudProviderRow(error)).toBe(true);
  });

  test("keeps conflict terminal without a retry action", () => {
    const conflict = resolveCloudProviderRowStatus({
      ...ready,
      imported: false,
      syncError: { kind: "conflict", message: "openwork already exists" },
    });
    expect(conflict).toBe("conflict");
    expect(canRetryCloudProviderRow(conflict)).toBe(false);
  });
});
