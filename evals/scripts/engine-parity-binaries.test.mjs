import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { downloadEngineArchive } from "./engine-parity-binaries.mjs";

for (const failure of ["unavailable", "interrupted", "permanent"]) {
  test(`pinned engine download handles a ${failure} transfer`, async t => {
    const directory = await mkdtemp(join(tmpdir(), "engine-download-"));
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      if (failure === "permanent") { response.writeHead(404).end(); return; }
      if (requests === 1) {
        if (failure === "unavailable") { response.writeHead(503).end(); return; }
        response.writeHead(200, { "content-length": "1000" });
        response.write("partial archive");
        setTimeout(() => response.destroy(), 20);
        return;
      }
      response.end("complete pinned archive bytes");
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
    const archive = join(directory, "binary.tgz");
    const download = downloadEngineArchive(`http://127.0.0.1:${server.address().port}/archive`, archive);
    if (failure === "permanent") {
      await assert.rejects(download);
      assert.equal(requests, 3);
    } else {
      await download;
      assert.equal(requests, 2);
      assert.equal(await readFile(archive, "utf8"), "complete pinned archive bytes");
    }
  });
}
