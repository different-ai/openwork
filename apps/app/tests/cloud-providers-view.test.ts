import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  canRetryCloudProviderRow,
  resolveCloudProviderRowStatus,
  type CloudProviderRowStateInput,
} from "../src/react-app/domains/settings/pages/cloud-providers-view";

const viewSource = readFileSync(
  new URL("../src/react-app/domains/settings/pages/cloud-providers-view.tsx", import.meta.url),
  "utf8",
);

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

  test("never claims Connected while the server still owes an engine reload", () => {
    // Truthfulness gate for #3671's UI layer: the provider is materialized
    // (listed by /cloud-provider-sync/status) but its models are not served
    // until the pending reload lands, so the row must stay in progress.
    expect(resolveCloudProviderRowStatus({ ...ready, reloadPending: true })).toBe("syncing");
    expect(resolveCloudProviderRowStatus({ ...ready, reloadPending: false })).toBe("connected");
  });

  test("surfaces a server-side skip as the credential attention state instead of endless Syncing", () => {
    const skipped = resolveCloudProviderRowStatus({
      ...ready,
      imported: false,
      skippedByServer: true,
    });
    expect(skipped).toBe("needs_credential");
    expect(canRetryCloudProviderRow(skipped)).toBe(false);
  });

  test("uses modern server materialization instead of Den's credential summary", () => {
    // A Den provider without an org credential can still be materialized by
    // the server from a matching local Desktop environment variable. When the
    // server owns sync (serverSync !== null), the rows derive credential
    // state only from the server's own skip list — Den's hasApiKey summary
    // and legacy renderer sync errors are gated off at the call site.
    expect(viewSource.includes(
      "needsCredential: serverSync === null && !provider.hasApiKey && env.length > 0",
    )).toBe(true);
    expect(viewSource.includes(
      "const syncError = serverSync === null ? lastSyncError[provider.id] ?? null : null;",
    )).toBe(true);
    // Server-materialized row: no legacy credential inputs, not skipped —
    // Connected even though Den reports no organization credential.
    expect(resolveCloudProviderRowStatus({ ...ready, skippedByServer: false })).toBe("connected");
    // Server-side skip still wins over an otherwise connected-looking row.
    expect(resolveCloudProviderRowStatus({ ...ready, skippedByServer: true })).toBe("needs_credential");
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
