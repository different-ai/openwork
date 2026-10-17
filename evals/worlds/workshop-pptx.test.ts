import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inspectWorkshopPptx, verifyWorkshopPptxPrerequisite } from "./workshop-pptx.ts";
const run = promisify(execFile);

test("parser prerequisites fail before paid work when the configured interpreter is absent", async () => {
  const previous = process.env.OPENWORK_WORKSHOP_PYTHON;
  process.env.OPENWORK_WORKSHOP_PYTHON = "/nonexistent/workshop-python";
  try { await assert.rejects(verifyWorkshopPptxPrerequisite(), /ENOENT/); }
  finally { if (previous === undefined) delete process.env.OPENWORK_WORKSHOP_PYTHON; else process.env.OPENWORK_WORKSHOP_PYTHON = previous; }
});

test("independent parser downloads exact ID, retains bytes and rejects renamed text", async () => {
  await verifyWorkshopPptxPrerequisite();
  const directory = await mkdtemp(join(tmpdir(), "workshop-pptx-regression-"));
  const python = process.env.OPENWORK_WORKSHOP_PYTHON;
  const selected = python ? { command: python, args: [] } : { command: process.env.OPENWORK_WORKSHOP_UVX ?? "uvx", args: ["--from", "python-pptx", "python"] };
  const fixturePath = join(directory, "mechanism-fixture.pptx");
  const server = createServer((request, response) => {
    if (request.url === "/download/exact-file-id") { response.end(bytes); return; }
    if (request.url === "/download/renamed-text") { response.end("This is not an OOXML presentation"); return; }
    if (request.url === "/download/wrong-main-type") { response.end(wrongMainType); return; }
    response.writeHead(404).end();
  });
  let bytes: Buffer, wrongMainType: Buffer;
  try {
    // Synthetic parser control, not a seeded workshop deliverable or model output.
    await run(selected.command, [...selected.args, "-c", "from pptx import Presentation;import sys;p=Presentation();[(lambda s,i: setattr(s.shapes.title,'text','Parser control '+str(i)))(p.slides.add_slide(p.slide_layouts[0]),i) for i in range(3)];p.save(sys.argv[1])", fixturePath]);
    bytes = await readFile(fixturePath);
    const invalidTypePath = join(directory, "wrong-main-type.pptx");
    await run(selected.command, [...selected.args, "-c", "import sys,zipfile;src=zipfile.ZipFile(sys.argv[1]);dst=zipfile.ZipFile(sys.argv[2],'w');[(dst.writestr(name,src.read(name).replace(b'presentationml.presentation.main+xml',b'presentationml.presentation+xml') if name=='[Content_Types].xml' else src.read(name))) for name in src.namelist()];dst.close()", fixturePath, invalidTypePath]);
    wrongMainType = await readFile(invalidTypePath);
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("No owned parser fixture address");
    const options = { origin: `http://127.0.0.1:${address.port}`, sessionId: "parser-mechanism-control", directory: join(directory, "observed") };
    const result = await inspectWorkshopPptx({ ...options, fileId: "exact-file-id" });
    assert.ok("artifact" in result);
    assert.equal(result.artifact.fileId, "exact-file-id");
    assert.equal(result.artifact.slideCount, 3);
    assert.equal(result.artifact.validZip, true);
    assert.equal(result.artifact.validPresentation, true);
    assert.match(result.artifact.extractedText, /Parser control 2/);
    assert.equal(result.artifact.sha256, result.artifact.downloadedSha256);
    assert.deepEqual(await readFile(join(options.directory, `${result.artifact.sha256}.pptx`)), bytes);
    const invalid = await inspectWorkshopPptx({ ...options, fileId: "renamed-text" });
    assert.ok("artifact" in invalid);
    assert.equal(invalid.artifact.validPresentation, false);
    assert.equal(invalid.artifact.validZip, false);
    assert.equal(invalid.artifact.slideCount, 0);
    const invalidType = await inspectWorkshopPptx({ ...options, fileId: "wrong-main-type" });
    assert.ok("artifact" in invalidType);
    assert.equal(invalidType.artifact.validPresentation, false, "A CRC-valid ZIP with the wrong OOXML main type is still not a valid PowerPoint");
    assert.equal(invalidType.artifact.slideCount, 0);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});
