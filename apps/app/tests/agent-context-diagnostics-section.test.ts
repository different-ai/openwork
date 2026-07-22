import { describe, expect, test } from "bun:test";

import {
  createOpaqueDiagnosticsScopeKey,
  readDiagnosticsValueForScope,
} from "../src/react-app/domains/settings/pages/agent-context-diagnostics-section";

describe("Agent diagnostics scope", () => {
  test("a report from an old workspace or organization cannot render or copy", () => {
    const originalIdentity = { workspace: "workspace_a", organization: "org_a" };
    const originalScope = { key: originalIdentity, generation: 0 };
    const storedReport = { scope: originalScope, value: "report-from-org-a" };

    expect(readDiagnosticsValueForScope(storedReport, {
      key: { workspace: "workspace_a", organization: "org_b" },
      generation: 1,
    })).toBeNull();
    expect(readDiagnosticsValueForScope(storedReport, {
      key: { workspace: "workspace_a", organization: "org_a" },
      generation: 2,
    })).toBeNull();
    // A credential or signed-in-principal change creates a new opaque scope
    // identity even when every public route field remains the same.
    expect(readDiagnosticsValueForScope(storedReport, {
      key: { workspace: "workspace_a", organization: "org_a" },
      generation: 0,
    })).toBeNull();
    expect(readDiagnosticsValueForScope(storedReport, originalScope)).toBe("report-from-org-a");
  });

  test("credential and principal changes create opaque invalidation keys without retaining secrets", () => {
    const client = {};
    const commonSignals = {
      client,
      workspaceId: "workspace_a",
      workspaceType: "local",
      denBaseUrl: "https://api.example.test",
      denSignedIn: true,
      organizationId: "org_a",
    };
    const credentialAKey = createOpaqueDiagnosticsScopeKey({
      ...commonSignals,
      workspaceCredential: "workspace-secret-a",
      denCredential: "den-secret-a",
      principalId: "user_a",
    });
    const credentialBKey = createOpaqueDiagnosticsScopeKey({
      ...commonSignals,
      workspaceCredential: "workspace-secret-b",
      denCredential: "den-secret-b",
      principalId: "user_a",
    });
    const principalBKey = createOpaqueDiagnosticsScopeKey({
      ...commonSignals,
      workspaceCredential: "workspace-secret-b",
      denCredential: "den-secret-b",
      principalId: "user_b",
    });
    const storedReport = {
      scope: { key: credentialAKey, generation: 0 },
      value: "credential-a-report",
    };

    expect(readDiagnosticsValueForScope(storedReport, {
      key: credentialBKey,
      generation: 1,
    })).toBeNull();
    expect(readDiagnosticsValueForScope(storedReport, {
      key: principalBKey,
      generation: 2,
    })).toBeNull();
    expect(Object.keys(credentialAKey)).toEqual([]);
    const serializedKeys = JSON.stringify([credentialAKey, credentialBKey, principalBKey]);
    expect(serializedKeys).toBe("[{},{},{}]");
    expect(serializedKeys).not.toContain("workspace-secret");
    expect(serializedKeys).not.toContain("den-secret");
    expect(serializedKeys).not.toContain("user_a");
  });
});
