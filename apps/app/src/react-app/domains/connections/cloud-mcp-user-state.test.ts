declare const afterEach: (fn: () => void) => void;
declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
  toEqual: (expected: unknown) => void;
};

import {
  __setCloudMcpUserStateStorageForTest,
  clearCloudMcpUnhealthyRemintAttempt,
  readCloudMcpUnhealthyRemintAttempt,
  writeCloudMcpUnhealthyRemintAttempt,
} from "./cloud-mcp-user-state";

const UNHEALTHY_REMINT_ATTEMPT_KEY = "openwork.den.mcp.unhealthyRemintAttempt";
const scope = {
  denBaseUrl: "https://cloud.openwork.test",
  serverBaseUrl: "https://worker.openwork.test",
  orgId: "org_1",
  workspaceId: "ws_1",
};

function createStorageStub() {
  const values = new Map<string, string>();
  return {
    values,
    storage: {
      getItem(key: string) {
        return values.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        values.set(key, value);
      },
      removeItem(key: string) {
        values.delete(key);
      },
    },
  };
}

afterEach(() => {
  __setCloudMcpUserStateStorageForTest(null);
});

describe("cloud MCP unhealthy re-mint attempt marker", () => {
  test("round-trips and clears the persisted marker", () => {
    const { storage } = createStorageStub();
    __setCloudMcpUserStateStorageForTest(storage);

    expect(readCloudMcpUnhealthyRemintAttempt(scope)).toBe(null);

    writeCloudMcpUnhealthyRemintAttempt({ ...scope, attemptedAt: 123 });
    expect(readCloudMcpUnhealthyRemintAttempt(scope)).toEqual({ ...scope, attemptedAt: 123 });

    clearCloudMcpUnhealthyRemintAttempt(scope);
    expect(readCloudMcpUnhealthyRemintAttempt(scope)).toBe(null);
  });

  test("returns null for corrupt JSON", () => {
    const { storage, values } = createStorageStub();
    __setCloudMcpUserStateStorageForTest(storage);
    values.set(UNHEALTHY_REMINT_ATTEMPT_KEY, "{");

    expect(readCloudMcpUnhealthyRemintAttempt(scope)).toBe(null);
  });

  test("keeps org-scoped markers separate", () => {
    const { storage } = createStorageStub();
    __setCloudMcpUserStateStorageForTest(storage);

    writeCloudMcpUnhealthyRemintAttempt({ ...scope, orgId: "org_a", attemptedAt: 456 });

    expect(readCloudMcpUnhealthyRemintAttempt(scope)).toBe(null);
    expect(readCloudMcpUnhealthyRemintAttempt({ ...scope, orgId: "org_a" })).toEqual({ ...scope, orgId: "org_a", attemptedAt: 456 });
  });
});
