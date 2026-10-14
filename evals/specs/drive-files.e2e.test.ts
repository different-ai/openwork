import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { driveFiles, inventoryExport, supplierWorkbook } from "../worlds/drive-files.ts";

const SHEET = "application/vnd.google-apps.spreadsheet";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// Browser-less: the real desktop host and Cloud gateway move file bytes; the agent's tool calls are made directly.
const test = spec.world(driveFiles, { resources: { surfaces: [], services: ["den"] }, needs: { commands: ["bun", "pnpm"], placement: "local" }, timeout: 600_000 });
test("an agent pulls a Drive file into the workspace, edits it with bash and saves it back without the file entering its context", async ({ world, step, evidence }) => {
  const supplierPath = "drive/Supplier entry.xlsx";
  const capability = (operation: string) => `native:${world.fullId}:${operation}`;
  const driveFile = async (id: string) => {
    const file = (await world.google.driveFiles(world.accounts.member)).find((entry) => entry.id === id);
    if (!file) throw new Error(`Drive file ${id} missing`);
    return { ...file, bytes: Buffer.from(file.contentBase64, "base64") };
  };

  await step("before: the inline Drive read cannot hand the agent a 9 MiB Excel file", async () => {
    const result = await world.mcp("execute_capability", { name: capability("getCapabilitiesGoogleWorkspaceDriveFile"), path: { fileId: world.files.supplier } });
    const file = world.objects(result).find((entry) => entry.id === world.files.supplier && "contentUnavailableReason" in entry);
    expect(file).toMatchObject({ content: null, contentBase64: null, contentUnavailableReason: "file_too_large" });
    evidence.recordAssertionEvidence("The inline read returns no content for a large Excel file", "The Drive read capability answered file_too_large with null content for the 9 MiB + 17 byte workbook, so an agent had no way to read or edit it.", true);
  });

  await step("the host pulls the file into the workspace and returns only its path and revision", async () => {
    // Only the drive_* engine tools reach these actions, so a push always passes their approval prompt.
    const actions = world.objects(await world.actions()).map((entry) => entry.action);
    expect(actions).toContain("drive_upload_file");
    expect(actions).not.toEqual(expect.arrayContaining(["drive_pull_file"]));
    expect(actions).not.toEqual(expect.arrayContaining(["drive_push_file"]));
    const pulled = await world.host("drive_pull_file", { fileId: `https://docs.google.com/spreadsheets/d/${world.files.supplier}/edit?rtpof=true`, connectionId: world.fullId });
    expect(pulled.status, JSON.stringify(pulled.body)).toBe(200);
    expect(pulled.body).toMatchObject({ ok: true, path: supplierPath, size: supplierWorkbook.byteLength, mimeType: XLSX, file: { id: world.files.supplier, revision: "rev-1" } });
    expect(JSON.stringify(pulled.body).length).toBeLessThan(1_000);
    expect((await world.read(supplierPath)).equals(supplierWorkbook)).toBe(true);
    expect(await world.contentRequests(world.files.supplier)).toBe(2);
    const again = await world.host("drive_pull_file", { fileId: world.files.supplier, connectionId: world.fullId });
    expect(again.body).toMatchObject({ ok: true, upToDate: true, path: supplierPath, file: { revision: "rev-1" } });
    expect(await world.contentRequests(world.files.supplier)).toBe(2);
    evidence.recordAssertionEvidence("A pull saves the exact bytes and returns no content", "From a Sheets-style link, drive_pull_file saved all 9,437,201 bytes to drive/Supplier entry.xlsx in two ranged chunks (md5 checked) and returned under 1 KB of metadata: path, size, type, file ID and revision rev-1. Pulling again reported upToDate without another download. The Drive actions are not listed for direct calls; only the approval-gated drive_* tools use them.", true);
  });

  await step("bash edits the local copy and status reports the unpushed edit", async () => {
    const edit = await world.bash(`printf 'row 12: Acme Supplies' | dd of='${supplierPath}' bs=1 seek=4096 conv=notrunc 2>/dev/null`);
    expect(edit.code, edit.stderr).toBe(0);
    const status = await world.host("drive_file_status", { path: supplierPath });
    expect(status.body).toMatchObject({ ok: true, files: [{ path: supplierPath, fileId: world.files.supplier, local: "edited", drive: "unchanged", revision: "rev-1" }] });
    evidence.recordAssertionEvidence("Shell edits are tracked against the pulled revision", "A dd command changed bytes in place; drive_file_status reported local edited and Drive unchanged at rev-1.", true);
  });

  await step("push replaces the Drive file in place as a new version", async () => {
    const local = await world.read(supplierPath);
    const pushed = await world.host("drive_push_file", { path: supplierPath });
    expect(pushed.status, JSON.stringify(pushed.body)).toBe(200);
    expect(pushed.body).toMatchObject({ ok: true, mode: "replace", file: { id: world.files.supplier, revision: "rev-2" }, previousRevision: "rev-1" });
    const drive = await driveFile(world.files.supplier);
    expect(drive.bytes.equals(local)).toBe(true);
    expect((await world.host("drive_file_status", { path: supplierPath })).body).toMatchObject({ files: [{ local: "unchanged", drive: "unchanged", revision: "rev-2" }] });
    expect((await world.host("drive_push_file", { path: supplierPath })).body).toMatchObject({ ok: true, unchanged: true });
    expect((await driveFile(world.files.supplier)).revision).toBe("rev-2");
    evidence.recordAssertionEvidence("Push keeps the same file and adds a version", "drive_push_file replaced the same file ID (rev-1 to rev-2) with the exact local bytes through a resumable upload; status was clean afterwards and a second push without changes sent nothing.", true);
  });

  await step("a Drive edit made after the pull is never overwritten silently", async () => {
    const theirs = Buffer.from("a collaborator's newer workbook");
    await world.google.editDriveFile(world.accounts.member, world.files.supplier, theirs);
    expect((await world.bash(`printf 'row 13: Beta Parts' | dd of='${supplierPath}' bs=1 seek=8192 conv=notrunc 2>/dev/null`)).code).toBe(0);
    expect((await world.host("drive_file_status", { path: supplierPath })).body).toMatchObject({ files: [{ local: "edited", drive: "changed", currentRevision: "rev-3" }] });
    const refused = await world.host("drive_push_file", { path: supplierPath });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "drive_conflict" });
    expect((await driveFile(world.files.supplier)).bytes.equals(theirs)).toBe(true);
    const local = await world.read(supplierPath);
    const copy = await world.host("drive_push_file", { path: supplierPath, mode: "copy" });
    expect(copy.status, JSON.stringify(copy.body)).toBe(200);
    expect(copy.body).toMatchObject({ ok: true, mode: "copy", copiedFrom: world.files.supplier, file: { name: "Supplier entry (edited).xlsx", mimeType: XLSX } });
    const saved = await driveFile(String((copy.body.file as Record<string, unknown>).id));
    expect(saved.parents).toEqual(["suppliers-folder"]);
    expect(saved.bytes.equals(local)).toBe(true);
    expect((await driveFile(world.files.supplier)).bytes.equals(theirs)).toBe(true);
    evidence.recordAssertionEvidence("Conflicts are refused and edits survive as a copy", "After a collaborator's change (rev-3), status showed both sides changed and push returned drive_conflict with Drive untouched. Push as copy saved the local edits as Supplier entry (edited).xlsx in the same folder; the collaborator's version stayed.", true);
  });

  await step("a Google Sheet opened through a Drive shortcut comes down as xlsx and goes back as a new Google Sheet", async () => {
    const sheetPath = "drive/Inventory (2).xlsx";
    expect((await world.bash("printf 'my own notes' > drive/Inventory.xlsx")).code).toBe(0);
    const pulled = await world.host("drive_pull_file", { fileId: world.files.inventoryShortcut, connectionId: world.fullId });
    expect(pulled.body).toMatchObject({ ok: true, path: sheetPath, exportedAs: "xlsx", file: { id: world.files.inventory, mimeType: SHEET } });
    expect((await world.read(sheetPath)).equals(inventoryExport)).toBe(true);
    expect((await world.read("drive/Inventory.xlsx")).toString()).toBe("my own notes");
    expect((await world.bash(`printf ' widget,18' >> '${sheetPath}'`)).code).toBe(0);
    const repull = await world.host("drive_pull_file", { fileId: world.files.inventory, connectionId: world.fullId });
    expect(repull.status).toBe(409);
    expect(repull.body).toMatchObject({ code: "local_changes" });
    const replaced = await world.host("drive_push_file", { path: sheetPath, mode: "replace" });
    expect(replaced.status).toBe(400);
    expect(replaced.body).toMatchObject({ code: "native_file_replace_unsupported" });
    const local = await world.read(sheetPath);
    const saved = await world.host("drive_push_file", { path: sheetPath });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ ok: true, mode: "copy", file: { name: "Inventory (edited)", mimeType: SHEET } });
    const copy = await driveFile(String((saved.body.file as Record<string, unknown>).id));
    expect(copy.parents).toEqual(["inventory-folder"]);
    expect(Buffer.from(copy.exports[XLSX] ?? "", "base64").equals(local)).toBe(true);
    expect((await driveFile(world.files.inventory)).version).toBe("1");
    evidence.recordAssertionEvidence("Google Sheets round-trip as a new Google Sheet", "Pulling a Drive shortcut fetched the Sheet it points to, as xlsx with the exact export bytes, next to an unrelated file that already had the default name (left untouched). Re-pulling after a local edit was refused instead of discarding it. Replacing the Sheet from an upload was refused; the default push converted the edited workbook into a new Google Sheet in the same folder and left the original at version 1.", true);
  });

  await step("after: another member, a read-only connection and paths or symlinks outside the workspace are refused", async () => {
    const other = await world.describeAs("second", world.files.supplier);
    expect(other.status).toBe(502);
    expect(String(other.body.message)).toContain("may not have access");
    const pulled = await world.host("drive_pull_file", { fileId: world.files.supplier, connectionId: world.readOnlyId, path: "read-only/Supplier.xlsx" });
    expect(pulled.status, JSON.stringify(pulled.body)).toBe(200);
    expect((await world.bash("printf 'blocked' >> read-only/Supplier.xlsx")).code).toBe(0);
    const before = await driveFile(world.files.supplier);
    const denied = await world.host("drive_push_file", { path: "read-only/Supplier.xlsx" });
    expect(denied.status).toBe(409);
    expect(denied.body).toMatchObject({ code: "needs_connection" });
    const after = await driveFile(world.files.supplier);
    expect([after.revision, after.bytes.equals(before.bytes)]).toEqual([before.revision, true]);
    const escaped = await world.host("drive_pull_file", { fileId: world.files.supplier, connectionId: world.fullId, path: "../outside.xlsx" });
    expect(escaped.status).toBe(403);
    expect(escaped.body).toMatchObject({ code: "path_outside_workspace" });
    expect((await world.bash("mkdir -p ../outside && ln -s ../outside linked")).code).toBe(0);
    const linked = await world.host("drive_pull_file", { fileId: world.files.supplier, connectionId: world.fullId, path: "linked/Supplier.xlsx" });
    expect(linked.status).toBe(403);
    expect(linked.body).toMatchObject({ code: "path_outside_workspace" });
    expect((await world.bash("ls -A ../outside | wc -l")).stdout.trim()).toBe("0");
    evidence.recordAssertionEvidence("Pulls and pushes stay inside the member's own access", "Another member's Google account got Google's no-access reason. A read-only connection could pull but its push returned needs_connection with the Drive file unchanged. A path outside the workspace and a folder symlinked outside it were both refused, and nothing was written there.", true);
  });
});
