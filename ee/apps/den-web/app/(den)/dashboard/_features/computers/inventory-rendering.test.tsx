import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { computerSourceAccessSchema, type ComputerInventoryRow } from "@openwork/types/den/computer-inventory";
import type { RemoteDeviceEvent } from "@openwork/types/den/remote-devices";
import { myComputerActions, disconnectOwnConfirm, removeConfirm } from "./computer-actions";
import { InventoryDetailActions } from "./inventory-actions";
import { InventoryRunCodeCard, SharedFolderRows } from "./inventory-detail";
import { InventoryRows } from "./inventory-rows";
import { renameMyComputer } from "./my-computers-data";
import { MyComputerActivity } from "./my-computers-screen";

const date = "2026-10-01T12:00:00.000Z";
const now = Date.parse(date);
const desktop: ComputerInventoryRow = {
  id: "studio-mac", label: "Studio Mac", kind: "desktop", kindLabel: "Mac desktop", owner: null, shared: false,
  status: { state: "online", lastSeenAt: date }, notes: [], runCode: { value: "no", reason: "sandbox_unavailable" },
  sessions: { sendTasks: false, readSessions: "none", access: null }, mergedSignIns: 0,
  canRename: true, canDisconnect: false, canRemove: false,
};
const noop = () => undefined;

test("the run-code column keeps a desktop's No and its lock reason visible", () => {
  const html = renderToStaticMarkup(<InventoryRows rows={[desktop]} openId="" now={now} onToggle={noop} detail={noop} />);
  assert.match(html, /data-run-code="no"/);
  assert.match(html, /aria-label="This computer can&#x27;t run the OpenWork sandbox\."/);
  assert.match(html, />No<\/span>/);
  assert.doesNotMatch(html, /Not available yet/);
});

test("the desktop owner's detail shows where to change a No, without a switch", () => {
  const html = renderToStaticMarkup(<InventoryRunCodeCard
    scope={{ orgId: "test-org", memberId: "test-member", admin: false, orgName: "Test organization" }}
    detail={{
      computer: desktop, callerIsOwner: true, activity: [], sessions: desktop.sessions,
      installed: { appVersion: null, platform: null, signedInAs: null, addedAt: date, lastSeenAt: date, mergedSignIns: [] },
      runCode: { value: { value: "no", reason: "owner" }, sources: [], canChange: true, canRevoke: true, canRestore: true },
      rules: { runCode: true, sessions: "off", requireSandboxOnPersonal: true },
    }} />);
  assert.match(html, /Its owner turned it off\./);
  assert.match(html, /Settings &gt; Devices on this computer/);
  assert.match(html, />No<svg[^>]*aria-hidden="true"/);
  assert.doesNotMatch(html, /role="switch"|Not available yet/);
});

test("desktop folder rows show the access for each folder and default to read-only", () => {
  const source = computerSourceAccessSchema.parse({
    key: "test-source", label: "Travel MacBook", scope: "sandbox", folders: ["/home/maya/reference", "/home/maya/drafts"], revokedAt: null, revokedBy: null,
  });
  const defaults = renderToStaticMarkup(<SharedFolderRows folders={source.folders} writableFolders={source.writableFolders} />);
  assert.equal(defaults.match(/Read-only/g)?.length, 2);
  const html = renderToStaticMarkup(<SharedFolderRows folders={source.folders} writableFolders={["/home/maya/drafts"]} />);
  assert.match(html, /\/home\/maya\/reference<\/code><span[^>]*>Read-only<\/span>/);
  assert.match(html, /\/home\/maya\/drafts<\/code><span[^>]*>Can edit<\/span>/);
});

test("a desktop can use the existing Rename action when Den allows it", () => {
  for (const canRename of [true, false]) {
    const row = { ...desktop, canRename };
    const html = renderToStaticMarkup(<InventoryDetailActions row={row} set={{
      actions: myComputerActions(row), name: row.label, disconnectConfirm: disconnectOwnConfirm(row.label), removeConfirm: removeConfirm(row.label),
      onRemove: async () => {}, onDisconnect: async () => {}, onRename: async () => {},
    }} />);
    assert.equal(/<button[^>]*>.*>Rename<\/div><\/button>/.test(html), canRename);
  }
});

test("rename passes the API's 409 name-taken sentence to the rename form", async (context) => {
  const message = "You already have a computer called that. Pick another name.";
  const fetch = context.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.match(String(input), /\/v1\/remote-devices\/studio-mac$/);
    assert.equal(init?.method, "PATCH");
    assert.equal(init?.body, JSON.stringify({ label: "Travel MacBook" }));
    return Response.json({ error: "name_taken", message }, { status: 409 });
  });
  await assert.rejects(renameMyComputer("test-org", desktop.id, "Travel MacBook"), { message });
  assert.equal(fetch.mock.callCount(), 1);
});

test("My Computers activity renders the complete API sentence in wrapping text", () => {
  const message = `Travel MacBook was allowed to read in /home/maya/${"reference".repeat(30)} on Studio Mac for Maya Okafor`;
  const event: RemoteDeviceEvent = { id: "event-1", createdAt: date, type: "computer_work_accepted", actor: "system", message, level: "info" };
  const html = renderToStaticMarkup(<MyComputerActivity events={[event]} now={now} />);
  assert.ok(html.includes(`<p class="min-w-0 flex-1 break-words">${message}</p>`));
});
