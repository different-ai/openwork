import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import constants from "../../../constants.json" with { type: "json" };
import nativeRuntime from "../../coworker/native-runtime.json" with { type: "json" };
import desktopArtifacts from "./opencode-v2-artifacts.json" with { type: "json" };
import coworkerArtifacts from "./opencode-v2-artifacts-beta19271.json" with { type: "json" };
import { installOpencodeV2Binary, resolveOpencodeV2Version } from "./opencode-v2-binary.js";
import * as serverFetch from "./server-fetch.js";

test("native artifact selection preserves Desktop's default and rejects unverified host pins and bytes", async () => {
  expect(constants.opencodeV2Version).toBe("0.0.0-beta-19086");
  expect(resolveOpencodeV2Version()).toBe(desktopArtifacts.version);
  expect(nativeRuntime.opencodeV2Version).toBe("0.0.0-beta-19271");
  expect(resolveOpencodeV2Version(nativeRuntime.opencodeV2Version)).toBe(coworkerArtifacts.version);
  expect(Object.keys(coworkerArtifacts.platforms)).toEqual(Object.keys(desktopArtifacts.platforms));
  const root = await mkdtemp(join(tmpdir(), "openwork-v2-pins-"));
  const requests: string[] = [];
  const fetch = spyOn(serverFetch, "externalFetch").mockImplementation(async (url) => {
    requests.push(url);
    return new Response("fixture bytes with invalid integrity");
  });
  try {
    for (const version of ["", "latest", "0.0.0-beta-unknown", "https://example.test/engine.tgz", "../0.0.0-beta-19271"]) {
      expect(() => resolveOpencodeV2Version(version)).toThrow("No verified OpenCode v2 artifacts");
      await expect(installOpencodeV2Binary(root, version)).rejects.toThrow("No verified OpenCode v2 artifacts");
    }
    expect(requests).toEqual([]);
    expect(await readdir(root)).toEqual([]);
    for (const [version, manifest] of [[undefined, desktopArtifacts], [nativeRuntime.opencodeV2Version, coworkerArtifacts]] satisfies Array<[string | undefined, typeof desktopArtifacts]>) {
      await expect(installOpencodeV2Binary(root, version)).rejects.toThrow("archive integrity mismatch");
      expect(Object.values(manifest.platforms).some((entry) => entry.url === requests.at(-1))).toBe(true);
    }
    expect(requests).toHaveLength(2);
    expect(requests[0]).toContain(desktopArtifacts.version);
    expect(requests[1]).toContain(coworkerArtifacts.version);
  } finally { fetch.mockRestore(); await rm(root, { recursive: true, force: true }); }
});
