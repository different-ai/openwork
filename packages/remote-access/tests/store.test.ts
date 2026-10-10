import { test, expect } from "vitest";
import {
  mkdtemp,
  readFile,
  stat,
  writeFile,
  chmod,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const api = (await import("../src/storage/store.js").catch(() => ({}))) as any;
test("private store is exclusive, durable and rejects corrupted authorization state", async () => {
  expect(api.Store).toBeTypeOf("function");
  const parent = await mkdtemp(join(tmpdir(), "owr-store-")),
    root = join(parent, "owned");
  try {
    const a = await api.Store.open(root);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    await expect(api.Store.open(root)).rejects.toThrow("STORE_LOCKED");
    const id = a.snapshot.hostId;
    await a.update((s: any) => {
      s.displayName = "Test host";
    });
    expect((await stat(join(root, "state.json"))).mode & 0o777).toBe(0o600);
    await a.close();
    const b = await api.Store.open(root);
    expect(b.snapshot.hostId).toBe(id);
    expect(b.snapshot.displayName).toBe("Test host");
    await b.close();
    await writeFile(join(root, "state.json"), "{broken");
    await expect(api.Store.open(root)).rejects.toThrow("INVALID_STORE");
    expect(await readFile(join(root, "state.json"), "utf8")).toBe("{broken");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
test("unsafe app-owned directory permissions fail without modifying them", async () => {
  expect(api.Store).toBeTypeOf("function");
  const root = await mkdtemp(join(tmpdir(), "owr-unsafe-"));
  try {
    await chmod(root, 0o755);
    await expect(api.Store.open(root)).rejects.toThrow("UNSAFE_PERMISSIONS");
    expect((await stat(root)).mode & 0o777).toBe(0o755);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
