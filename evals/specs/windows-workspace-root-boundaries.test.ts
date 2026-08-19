import { expect } from "vitest";
import { briefTest, claim, testBrief } from "@openwork/testkit";
import { normalizeWorkspaceRootPath } from "../../packages/paths/index.mjs";
import { prepareRuntimeWorkspaceRoot } from "../../apps/desktop/electron/runtime.mjs";

briefTest(testBrief({
  behavior: "Windows workspace roots stay within filesystem path boundaries and fail recoverably when unavailable.",
  claims: {
    verbatimNormalization: claim("valid verbatim drive and UNC roots normalize to ordinary Windows filesystem paths", {
      never: "retain a Windows device namespace prefix",
    }),
    deviceRejection: claim("Win32 device namespace roots are rejected", {
      never: "treat named pipes or physical devices as workspaces",
    }),
    disconnectedRetention: claim("a normal disconnected drive root remains unchanged", {
      never: "resolve it against a different drive or consult its availability during normalization",
    }),
    inaccessibleRecovery: claim("an inaccessible root reports workspace_inaccessible and can be retried", {
      never: "surface the injected filesystem error unwrapped or lose the requested workspace path",
    }),
  },
}), async ({ prove }) => {
  const driveRoot = normalizeWorkspaceRootPath("\\\\?\\C:\\Users\\Ada\\Workspace", { platform: "win32" });
  const uncRoot = normalizeWorkspaceRootPath("\\\\?\\UNC\\server\\share\\Workspace", { platform: "win32" });
  expect(driveRoot).toBe("C:\\Users\\Ada\\Workspace");
  expect(uncRoot).toBe("\\\\server\\share\\Workspace");
  expect(driveRoot).not.toMatch(/^\\\\[?.]\\/);
  expect(uncRoot).not.toMatch(/^\\\\[?.]\\/);
  prove.verbatimNormalization(
    true,
    `The verbatim drive normalized to ${driveRoot} and the verbatim UNC root normalized to ${uncRoot}; neither retained a device namespace prefix.`,
  );

  const deviceRoots = [
    "\\\\.\\pipe\\openwork",
    "//./PIPE/openwork",
    "\\\\.\\PhysicalDrive0",
  ];
  for (const deviceRoot of deviceRoots) {
    let thrown: unknown;
    try {
      normalizeWorkspaceRootPath(deviceRoot, { platform: "win32" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect(thrown).toMatchObject({ code: "invalid_workspace_root" });
  }
  prove.deviceRejection(
    true,
    `All ${deviceRoots.length} injected device namespace roots threw TypeError with invalid_workspace_root instead of becoming workspaces.`,
  );

  const disconnectedRoot = "Z:\\Disconnected\\Workspace";
  const retainedRoot = normalizeWorkspaceRootPath(disconnectedRoot, { platform: "win32" });
  expect(retainedRoot).toBe(disconnectedRoot);
  expect(retainedRoot).not.toMatch(/^C:/i);
  prove.disconnectedRetention(
    true,
    `${disconnectedRoot} was retained byte-for-byte and was not resolved onto the current drive.`,
  );

  const rawInaccessibleRoot = "\\\\?\\Z:\\Disconnected\\Workspace";
  const normalizedInaccessibleRoot = "Z:\\Disconnected\\Workspace";
  const filesystemError = Object.assign(new Error("drive is unavailable"), { code: "ENOENT" });
  const attemptedRoots: string[] = [];
  await expect(prepareRuntimeWorkspaceRoot(rawInaccessibleRoot, {
    platform: "win32",
    mkdirImpl: async (workspaceRoot: string) => {
      attemptedRoots.push(workspaceRoot);
      throw filesystemError;
    },
  })).rejects.toMatchObject({
    code: "workspace_inaccessible",
    workspacePath: rawInaccessibleRoot,
    cause: filesystemError,
  });
  const retriedRoot = await prepareRuntimeWorkspaceRoot(rawInaccessibleRoot, {
    platform: "win32",
    mkdirImpl: async (workspaceRoot: string) => {
      attemptedRoots.push(workspaceRoot);
    },
  });
  expect(attemptedRoots).toEqual([normalizedInaccessibleRoot, normalizedInaccessibleRoot]);
  expect(retriedRoot).toBe(normalizedInaccessibleRoot);
  prove.inaccessibleRecovery(
    true,
    `The injected ENOENT was wrapped as workspace_inaccessible for ${rawInaccessibleRoot}; a retry targeted ${normalizedInaccessibleRoot} again and succeeded.`,
  );
});
