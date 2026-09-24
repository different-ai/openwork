import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DESKTOP_TRANSFER_MAX_BYTES,
  createDesktopTransferRegistry,
  downloadBinaryToPath,
  uploadMultipartFromBytes,
} from "./binary-transfer.mjs";

const allowedUrlPrefixes = ["https://worker.example.test"];

async function withWorkspace(run) {
  const base = await mkdtemp(path.join(os.tmpdir(), "openwork-binary-transfer-"));
  const root = path.join(base, "root");
  const stagingDir = path.join(base, "staging");
  await mkdir(root, { recursive: true });
  try {
    await run(root, stagingDir);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

function remoteResponse(bytes, init = {}) {
  return new Response(bytes, { status: 200, headers: init.headers });
}

function matchesError(error, code, messagePattern) {
  return error instanceof Error
    && Reflect.get(error, "code") === code
    && (!messagePattern || messagePattern.test(error.message));
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise((done) => { resolve = () => done(undefined); });
  return { promise, resolve };
}

test("desktop cancellation stays sender-scoped and releases registry entries on every settlement", async () => {
  const registry = createDesktopTransferRegistry();
  const owner = { sender: Object.assign(new EventEmitter(), { id: 1 }) };
  const other = { sender: Object.assign(new EventEmitter(), { id: 2 }) };
  const hold = (signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const pending = registry.run(owner, "read-1", hold);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  assert.equal(registry.cancel(other, "read-1"), false);
  await assert.rejects(registry.run(owner, "read-1", hold), /already active/);
  assert.equal(registry.cancel(owner, "read-1"), true);
  await rejected;
  assert.equal(registry.cancel(owner, "read-1"), false);
  assert.equal(owner.sender.listenerCount("destroyed"), 0);
  assert.equal(await registry.run(owner, "read-1", async () => "complete"), "complete");
  await assert.rejects(registry.run(owner, "read-1", async () => { throw new Error("failed"); }), /failed/);
  const destroyed = assert.rejects(registry.run(owner, "read-1", hold), { name: "AbortError" });
  owner.sender.emit("destroyed");
  await destroyed;
  assert.equal(owner.sender.listenerCount("destroyed"), 0);
  assert.equal(registry.cancel(owner, "read-1"), false);
});

for (const phase of ["headers", "body"]) {
  test(`desktop registry cancellation closes the upstream GET during ${phase}`, { timeout: 5_000 }, async (t) => {
    const registry = createDesktopTransferRegistry();
    const owner = { sender: Object.assign(new EventEmitter(), { id: 1 }) };
    const arrived = deferred();
    const closed = deferred();
    const server = createServer((_request, response) => {
      response.once("close", closed.resolve);
      if (phase === "body") {
        response.writeHead(200, { "content-type": "application/json" });
        response.write("[");
      }
      arrived.resolve();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
    t.after(async () => {
      registry.cancel(owner, "history");
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const reading = deferred();
    const pending = registry.run(owner, "history", async (signal) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/session/ses_1/message`, { signal });
      reading.resolve();
      return response.text();
    });
    const rejected = assert.rejects(pending, { name: "AbortError" });
    await arrived.promise;
    if (phase === "body") await reading.promise;
    assert.equal(registry.cancel(owner, "history"), true);
    await rejected;
    await closed.promise;
    assert.equal(registry.cancel(owner, "history"), false);
    assert.equal(owner.sender.listenerCount("destroyed"), 0);
  });
}

test("uploads exact original multipart bytes with spaces and Unicode in the filename", async () => {
  await withWorkspace(async () => {
    const filename = "résumé image 你好.bin";
    const original = Uint8Array.from([0, 1, 2, 127, 128, 200, 254, 255]);

    const result = await uploadMultipartFromBytes({
      url: "https://worker.example.test/inbox",
      bytes: original.slice().buffer,
      filename,
      size: original.byteLength,
      contentType: "application/octet-stream",
      fields: { path: `uploads/${filename}` },
      headers: { Authorization: "Bearer test" },
    }, {
      allowedUrlPrefixes,
      fetcher: async (url, init) => {
        assert.equal(init.redirect, "error");
        const request = new Request(url, init);
        const form = await request.formData();
        const file = form.get("file");
        assert.ok(file instanceof Blob);
        assert.deepEqual(new Uint8Array(await file.arrayBuffer()), original);
        assert.equal(file.name, filename);
        assert.equal(form.get("path"), `uploads/${filename}`);
        assert.equal(request.headers.get("authorization"), "Bearer test");
        return Response.json({ ok: true });
      },
    });

    assert.equal(result.status, 200);
    assert.equal(result.body, '{"ok":true}');
  });
});

test("downloads high bytes exactly through a verified destination handle with no stray files", async () => {
  await withWorkspace(async (root, stagingDir) => {
    const destinationPath = path.join(root, "資料 high bytes.bin");
    const original = Uint8Array.from([255, 254, 253, 0, 128, 129, 200, 10]);
    const options = {
      authorizedRoots: [root],
      allowedUrlPrefixes,
      stagingDir,
      fetcher: async (url, init) => {
        assert.equal(init.redirect, "error");
        return remoteResponse(original, {
          headers: { "content-type": "application/octet-stream" },
        });
      },
    };

    const result = await downloadBinaryToPath({
      url: "https://worker.example.test/files/raw",
      destinationPath,
    }, options);

    assert.equal(result.path, destinationPath);
    assert.equal(result.bytes, original.byteLength);
    assert.deepEqual(new Uint8Array(await readFile(destinationPath)), original);
    assert.deepEqual(await readdir(path.dirname(destinationPath)), [path.basename(destinationPath)]);
    assert.deepEqual(await readdir(stagingDir), []);

    await assert.rejects(
      downloadBinaryToPath({
        url: "https://worker.example.test/files/raw",
        destinationPath,
      }, options),
      (error) => matchesError(error, "destination-exists", /already exists/i),
    );
    assert.deepEqual(new Uint8Array(await readFile(destinationPath)), original);
  });
});

test("rejects zero-byte, oversized, and size-mismatched uploads with clear error codes", async () => {
  await withWorkspace(async () => {
    const options = { allowedUrlPrefixes, fetcher: async () => Response.json({}) };
    await assert.rejects(
      uploadMultipartFromBytes({
        url: "https://worker.example.test/inbox",
        bytes: new ArrayBuffer(0),
        filename: "empty.bin",
        size: 0,
      }, options),
      (error) => matchesError(error, "zero-byte-file", /greater than zero/i),
    );

    await assert.rejects(
      uploadMultipartFromBytes({
        url: "https://worker.example.test/inbox",
        bytes: Uint8Array.from([1]).buffer,
        filename: "small.bin",
        size: DESKTOP_TRANSFER_MAX_BYTES + 1,
      }, options),
      (error) => matchesError(error, "file-too-large", /limit/i),
    );

    await assert.rejects(
      uploadMultipartFromBytes({
        url: "https://worker.example.test/inbox",
        bytes: Uint8Array.from([1, 2, 3]).buffer,
        filename: "short.bin",
        size: 4,
      }, options),
      (error) => matchesError(error, "size-mismatch", /expected 4 bytes/i),
    );
  });
});

test("rejects zero-byte and oversized downloads without leaving partial files", async () => {
  await withWorkspace(async (root, stagingDir) => {
    const zeroDestination = path.join(root, "zero.bin");
    await assert.rejects(
      downloadBinaryToPath({
        url: "https://worker.example.test/file",
        destinationPath: zeroDestination,
      }, { authorizedRoots: [root], allowedUrlPrefixes, stagingDir, fetcher: async () => remoteResponse(new Uint8Array()) }),
      (error) => matchesError(error, "zero-byte-file", /empty/i),
    );
    await assert.rejects(readFile(zeroDestination), { code: "ENOENT" });

    const largeDestination = path.join(root, "large.bin");
    await assert.rejects(
      downloadBinaryToPath({
        url: "https://worker.example.test/file",
        destinationPath: largeDestination,
        maxBytes: 3,
      }, { authorizedRoots: [root], allowedUrlPrefixes, stagingDir, fetcher: async () => remoteResponse(Uint8Array.from([1, 2, 3, 4])) }),
      (error) => matchesError(error, "file-too-large", /limit/i),
    );
    await assert.rejects(readFile(largeDestination), { code: "ENOENT" });
    assert.deepEqual(await readdir(root), []);
    assert.deepEqual(await readdir(stagingDir), []);
  });
});

test("cancellation removes the incomplete download", async () => {
  await withWorkspace(async (root, stagingDir) => {
    const destinationPath = path.join(root, "cancelled.bin");
    const controller = new AbortController();
    const response = new Response(new ReadableStream({
      pull(streamController) {
        streamController.enqueue(Uint8Array.from([1, 2, 3]));
        controller.abort();
      },
    }));

    await assert.rejects(
      downloadBinaryToPath({
        url: "https://worker.example.test/file",
        destinationPath,
      }, { authorizedRoots: [root], allowedUrlPrefixes, stagingDir, fetcher: async () => response, signal: controller.signal }),
      (error) => error instanceof Error && error.name === "AbortError",
    );

    await assert.rejects(readFile(destinationPath), { code: "ENOENT" });
    assert.deepEqual(await readdir(root), []);
    assert.deepEqual(await readdir(stagingDir), []);
  });
});

test("rejects traversal, nested, and symlink download destinations", async () => {
  await withWorkspace(async (root, stagingDir) => {
    const authorizedRoot = path.join(root, "workspace");
    const outsideRoot = path.join(root, "outside");
    await mkdir(authorizedRoot);
    await mkdir(outsideRoot);
    const options = {
      authorizedRoots: [authorizedRoot],
      allowedUrlPrefixes,
      stagingDir,
      fetcher: async () => remoteResponse(Uint8Array.from([1])),
    };

    await assert.rejects(
      downloadBinaryToPath({
        url: "https://worker.example.test/file",
        destinationPath: path.join(authorizedRoot, "..", "outside", "escape.bin"),
      }, options),
      (error) => matchesError(error, "unauthorized-path"),
    );

    const nestedDirectory = path.join(authorizedRoot, "nested");
    await mkdir(nestedDirectory);
    await assert.rejects(
      downloadBinaryToPath({
        url: "https://worker.example.test/file",
        destinationPath: path.join(nestedDirectory, "escape.bin"),
      }, options),
      (error) => matchesError(error, "nested-destination", /directly inside/i),
    );

    const linkedDirectory = path.join(authorizedRoot, "linked");
    await symlink(outsideRoot, linkedDirectory, "dir");
    await assert.rejects(
      downloadBinaryToPath({
        url: "https://worker.example.test/file",
        destinationPath: path.join(linkedDirectory, "escape.bin"),
      }, options),
      (error) => matchesError(error, "nested-destination"),
    );

    const symlinkDestination = path.join(authorizedRoot, "link.bin");
    await symlink(path.join(outsideRoot, "target.bin"), symlinkDestination);
    await assert.rejects(
      downloadBinaryToPath({
        url: "https://worker.example.test/file",
        destinationPath: symlinkDestination,
      }, options),
      (error) => matchesError(error, "symlink-path"),
    );

    assert.deepEqual(await readdir(outsideRoot), []);
  });
});

test("rejects transfer URLs outside connected remote workspace endpoints", async () => {
  await withWorkspace(async (root, stagingDir) => {
    const upload = (url, prefixes) => uploadMultipartFromBytes({
      url,
      bytes: Uint8Array.from([100, 97, 116, 97]).buffer,
      filename: "leak.bin",
      size: 4,
    }, {
      allowedUrlPrefixes: prefixes,
      fetcher: async () => Response.json({ ok: true }),
    });

    await assert.rejects(
      upload("https://attacker.example.test/exfil", allowedUrlPrefixes),
      (error) => matchesError(error, "unauthorized-url", /remote workspace/i),
    );
    await assert.rejects(
      upload("https://worker.example.test/inbox", []),
      (error) => matchesError(error, "unauthorized-url"),
    );
    await assert.rejects(
      upload("https://worker.example.test/other/inbox", ["https://worker.example.test/workspace/team"]),
      (error) => matchesError(error, "unauthorized-url"),
    );
    const scoped = await upload(
      "https://worker.example.test/workspace/team/inbox",
      ["https://worker.example.test/workspace/team"],
    );
    assert.equal(scoped.status, 200);

    const destinationPath = path.join(root, "payload.bin");
    await assert.rejects(
      downloadBinaryToPath({
        url: "https://attacker.example.test/payload",
        destinationPath,
      }, {
        authorizedRoots: [root],
        allowedUrlPrefixes,
        stagingDir,
        fetcher: async () => remoteResponse(Uint8Array.from([1])),
      }),
      (error) => matchesError(error, "unauthorized-url"),
    );
    await assert.rejects(readFile(destinationPath), { code: "ENOENT" });
  });
});

test("rejects a download whose workspace root is swapped for a symlink during the fetch", async () => {
  await withWorkspace(async (root, stagingDir) => {
    const authorizedRoot = path.join(root, "workspace");
    const outsideRoot = path.join(root, "outside");
    await mkdir(authorizedRoot);
    await mkdir(outsideRoot);
    const destinationPath = path.join(authorizedRoot, "swapped.bin");

    await assert.rejects(
      downloadBinaryToPath({
        url: "https://worker.example.test/file",
        destinationPath,
      }, {
        authorizedRoots: [authorizedRoot],
        allowedUrlPrefixes,
        stagingDir,
        fetcher: async () => {
          await rm(authorizedRoot, { recursive: true, force: true });
          await symlink(outsideRoot, authorizedRoot, "dir");
          return remoteResponse(Uint8Array.from([1, 2, 3]));
        },
      }),
      (error) => matchesError(error, "symlink-path")
        || matchesError(error, "unauthorized-path")
        || matchesError(error, "path-changed"),
    );

    assert.deepEqual(await readdir(outsideRoot), []);
    assert.deepEqual(await readdir(stagingDir), []);
  });
});
