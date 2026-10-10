import { test, expect } from "vitest";
import {
  mkdtemp,
  rm,
  stat,
  readFile,
  writeFile,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  localRemoteAccessPolicy,
  readSavedDevices,
  remoteAccessPreference,
} from "../src/desktop.js";
import { Store } from "../src/storage/store.js";

test("desktop preference is private, persistent, and rejects malformed storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "owr-preference-"));
  try {
    const preference = remoteAccessPreference(root);
    expect(await preference.read()).toBe(false);
    await preference.write(true);
    expect(await preference.read()).toBe(true);
    expect((await stat(join(root, "desktop.json"))).mode & 0o777).toBe(0o600);
    await writeFile(join(root, "desktop.json"), '{"enabled":"true"}');
    await expect(preference.read()).rejects.toThrow("INVALID_STORE");
    await preference.write(false);
    await chmod(join(root, "desktop.json"), 0o644);
    await expect(preference.read()).rejects.toThrow("UNSAFE_PERMISSIONS");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("saved-device preview works while the store is locked without changing state or returning credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "owr-preview-"));
  const store = await Store.open(root);
  try {
    await store.update((state) =>
      state.devices.push({
        id: "phone",
        deviceId: "private-device-id",
        name: "Phone",
        tokenHash: "a".repeat(64),
        workspaceIds: ["one"],
        allWorkspaces: false,
        active: true,
        revoked: false,
      }),
    );
    const before = await readFile(join(root, "state.json"), "utf8");
    const devices = await readSavedDevices(root);
    expect(devices).toEqual([
      {
        id: "phone",
        name: "Phone",
        workspaceIds: ["one"],
        allWorkspaces: false,
        active: true,
      },
    ]);
    expect(await readFile(join(root, "state.json"), "utf8")).toBe(before);
    expect(await readFile(join(root, "lock"), "utf8")).toBe(
      String(process.pid),
    );
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("local qualification follows the registry operator parser and defaults to no override", () => {
  expect(localRemoteAccessPolicy({})).toBeNull();
  expect(
    localRemoteAccessPolicy({ DEN_FEATURE_REMOTE_ACCESS: "true" }),
  ).toMatchObject({ enabled: true, source: "lock" });
  expect(
    localRemoteAccessPolicy({ DEN_FEATURE_REMOTE_ACCESS: "false" }),
  ).toMatchObject({ enabled: false, source: "lock" });
  expect(() =>
    localRemoteAccessPolicy({ DEN_FEATURE_REMOTE_ACCESS: "1" }),
  ).toThrow("INVALID_FEATURE_ENVIRONMENT");
});
