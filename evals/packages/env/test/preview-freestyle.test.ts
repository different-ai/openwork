import assert from "node:assert/strict";
import { test } from "node:test";
import { bootFreestyleDesktop, freestyleDesktopPlan } from "../../../../worlds/lib/preview.ts";

const SHA = "b".repeat(40);
const sha = { desktop: { kind: "sha" as const, sha: SHA } };

test("Freestyle desktop maps only the signed-out fresh scenario from a pushed commit", () => {
  assert.deepEqual(freestyleDesktopPlan({ surface: "desktop", argv: [], sources: sha, seeds: [] }), { sha: SHA, lifetimeMinutes: 120 });
  assert.deepEqual(freestyleDesktopPlan({ surface: "desktop", argv: ["--lifetime", "30"], sources: { "*": { kind: "sha", sha: SHA } }, seeds: [{ name: "fresh" }] }),
    { sha: SHA, lifetimeMinutes: 30 });
  const refused: [Parameters<typeof freestyleDesktopPlan>[0], RegExp][] = [
    [{ surface: "den", argv: [], sources: sha, seeds: [] }, /preview-den cannot run on Freestyle/],
    [{ surface: "desktop", argv: ["--scenario", "team"], sources: sha, seeds: [] }, /only the signed-out fresh/],
    [{ surface: "desktop", argv: [], sources: sha, seeds: [{ name: "restricted" }] }, /only --seed fresh/],
    [{ surface: "desktop", argv: [], sources: { ...sha, den: { kind: "sha", sha: SHA } }, seeds: [] }, /no den component/],
    [{ surface: "desktop", argv: [], sources: { desktop: { kind: "release", version: "0.18.52", distribution: "public" } }, seeds: [] }, /needs --source desktop=sha/],
    [{ surface: "desktop", argv: [], sources: { desktop: { kind: "local" } }, seeds: [] }, /needs --source desktop=sha/],
    [{ surface: "desktop", argv: [], sources: {}, seeds: [] }, /needs --source desktop=sha/],
    [{ surface: "desktop", argv: ["--release", "0.18.52", "--distribution", "public", "--scenario", "blank"], sources: sha, seeds: [] }, /not a published release/],
    [{ surface: "desktop", argv: ["--lifetime", "0"], sources: sha, seeds: [] }, /10-1430 minutes/],
  ];
  for (const [input, error] of refused) assert.throws(() => freestyleDesktopPlan(input), error);
});

test("Freestyle desktop boots from its snapshot, records ownership, and deletes the VM on teardown", async () => {
  const calls: string[] = [];
  const deps = {
    ensureSnapshot: async (value: string) => { calls.push(`snapshot:${value}`); },
    launch: async (value: string, minutes: number) => {
      calls.push(`launch:${value}:${minutes}`);
      return { id: "vm-1", snapshotId: "snap-1", url: "https://desktop-x.preview.openwork.software/__openwork_launch?token=t", expiresAt: "2026-09-25T00:00:00.000Z",
        outputs: { desktopStatus: { value: "ready-signed-out" } } };
    },
    remove: async (id: string) => { calls.push(`remove:${id}`); },
    track: async (id: string) => { calls.push(`track:${id}`); },
  };
  {
    await using stack = new AsyncDisposableStack();
    const outputs = await bootFreestyleDesktop(stack, { sha: SHA, lifetimeMinutes: 30 }, deps);
    assert.equal(outputs.desktopStatus && typeof outputs.desktopStatus === "object" && "value" in outputs.desktopStatus ? outputs.desktopStatus.value : outputs.desktopStatus, "ready-signed-out");
    assert.ok(outputs.preview && typeof outputs.preview === "object" && "secret" in outputs.preview && outputs.preview.secret === true);
  }
  assert.deepEqual(calls, [`snapshot:${SHA}`, `launch:${SHA}:30`, "track:vm-1", "remove:vm-1"]);

  const notReady = { ...deps, launch: async () => ({ id: "vm-2", snapshotId: "s", url: "u", expiresAt: "e", outputs: { desktopStatus: { value: "starting" } } }) };
  calls.length = 0;
  {
    await using stack = new AsyncDisposableStack();
    await assert.rejects(bootFreestyleDesktop(stack, { sha: SHA, lifetimeMinutes: 30 }, notReady), /signed-out ready state/);
  }
  assert.deepEqual(calls, [`snapshot:${SHA}`, "track:vm-2", "remove:vm-2"]);
});
