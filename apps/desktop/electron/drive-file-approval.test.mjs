import assert from "node:assert/strict";
import { test } from "node:test";
import { driveFileApprovalOptions } from "./drive-file-approval.mjs";

const request = {
  provider: "google-workspace", action: "overwrite", name: "Project notes",
  path: "/Users/private/workspace/reports/notes.docx", displayPath: "reports/notes.docx",
  fileId: "private-file-id", webViewLink: "https://docs.google.com/document/d/private-file-id/edit?usp=drivesdk&ouid=private",
};

test("local overwrite confirmation names the relative destination and the destructive action", () => {
  const options = driveFileApprovalOptions(request);
  assert.equal(options.message, "Replace the local copy of Project notes?");
  assert.match(options.detail, /Replaces reports\/notes.docx/);
  assert.match(options.detail, /Local edits will be lost/);
  assert.match(options.detail, /Google Drive will not change/);
  assert.deepEqual(options.buttons, ["Cancel", "Replace local copy"]);
  assert.equal(options.defaultId, options.cancelId);
  assert.doesNotMatch(JSON.stringify(options), /private|https:|File ID|\/Users\//);
});

test("saving back names the service and who sees the changes, without IDs or URLs", () => {
  for (const provider of ["google-workspace", "microsoft-365"]) {
    const options = driveFileApprovalOptions({ ...request, provider, action: "push" });
    assert.match(options.detail, /People with access to it will see your changes/);
    assert.match(options.detail, /reports\/notes.docx/);
    assert.doesNotMatch(JSON.stringify(options), /private|https:|File ID|\/Users\//);
    assert.deepEqual(options.buttons, ["Cancel", "Save changes"]);
  }
});

test("save a copy explains that the original stays unchanged", () => {
  const options = driveFileApprovalOptions({ ...request, action: "push", mode: "copy" });
  assert.match(options.detail, /new file next to the original/);
  assert.match(options.detail, /original will not change/);
  assert.deepEqual(options.buttons, ["Cancel", "Save a copy"]);
});

test("missing and absolute display paths never leak a host path", () => {
  for (const displayPath of [undefined, "/Users/private/workspace/file.docx", "C:\\Users\\private\\workspace\\file.docx"]) {
    const options = driveFileApprovalOptions({ ...request, displayPath });
    assert.match(options.detail, /Replaces the workspace/);
    assert.doesNotMatch(JSON.stringify(options), /private|Users/);
  }
});
