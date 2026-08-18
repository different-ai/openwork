import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { importWorkspaceConfig } from "./workspace-archive.mjs";

function singleEntryArchive({ name, data, uncompressedSize = data.length }) {
  const nameBuffer = Buffer.from(name, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(uncompressedSize, 22);
  local.writeUInt16LE(nameBuffer.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(uncompressedSize, 24);
  central.writeUInt16LE(nameBuffer.length, 28);
  central.writeUInt32LE(0, 42);

  const centralOffset = local.length + nameBuffer.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBuffer.length, 12);
  end.writeUInt32LE(centralOffset, 16);

  return Buffer.concat([local, nameBuffer, data, central, nameBuffer, end]);
}

describe("workspace archive limits", () => {
  it("rejects an oversized entry before zlib or file writes run", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openwork-archive-test-"));
    const archivePath = path.join(root, "archive.zip");
    const targetDir = path.join(root, "target");
    try {
      await writeFile(archivePath, singleEntryArchive({
        name: ".opencode/openwork.json",
        data: Buffer.from("{}"),
        uncompressedSize: 17 * 1024 * 1024,
      }));

      await assert.rejects(
        importWorkspaceConfig({ archivePath, targetDir, name: null }),
        /exceeds the 16777216-byte limit/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
