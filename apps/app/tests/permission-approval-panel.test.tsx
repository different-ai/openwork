/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PendingPermission } from "../src/app/types";
import { PermissionApprovalPanel, permissionCanRemember } from "../src/react-app/domains/session/chat/permission-approval-modal";

function permission(always: unknown, kind = "drive_upload_file"): PendingPermission {
  return { id: "per_one", sessionID: "ses_one", permission: kind,
    patterns: ["drive-upload:opaque-exact-scope"], always,
    metadata: { path: "/local/report.pdf", target: "Google Drive folder selected-folder", connectionId: "google-workspace" }, receivedAt: 1, protocol: "v2" };
}

describe("truthful upload approval choices", () => {
  test("one-request-only approvals do not offer a non-working session button", () => {
    for (const always of [[], undefined, null, false, [""], [17]]) {
      expect(permissionCanRemember(permission(always))).toBe(false);
      const html = renderToStaticMarkup(<PermissionApprovalPanel permission={permission(always)} respondPermission={() => {}} />);
      expect(html).toContain("Allow once");
      expect(html).not.toContain("Allow for session");
    }
  });
  test("a saveable exact scope offers session approval and shows the actual file, not its opaque rule", () => {
    const request = permission(["drive-upload:opaque-exact-scope"]);
    expect(permissionCanRemember(request)).toBe(true);
    const html = renderToStaticMarkup(<PermissionApprovalPanel permission={request} respondPermission={() => {}} />);
    expect(html).toContain("Allow for session");
    expect(html).toContain("/local/report.pdf");
    expect(html).not.toContain("drive-upload:opaque-exact-scope");
  });
  test("an unresolved default account explains why this approval is single-request-only", () => {
    const request = { ...permission([]), metadata: { path: "/local/report.pdf", target: "Google Drive" } };
    const html = renderToStaticMarkup(<PermissionApprovalPanel permission={request} respondPermission={() => {}} />);
    expect(html).toContain("Default account: approval applies to this upload only.");
    expect(html).not.toContain("Allow for session");
  });
  test("ordinary permission scopes retain their readable resource and session choice", () => {
    const request = { ...permission(["/workspace/**"], "read"), patterns: ["/workspace/**"] };
    const html = renderToStaticMarkup(<PermissionApprovalPanel permission={request} respondPermission={() => {}} />);
    expect(html).toContain("/workspace/**");
    expect(html).toContain("Allow for session");
  });
});

describe("one approval card for every file sent to a connected account", () => {
  const kinds = ["drive_upload_file", "drive_push_file", "gmail_create_draft_with_attachments", "outlook_create_draft_with_attachments"];
  const send = (kind: string, remember: string[]): PendingPermission => ({ id: "per_one", sessionID: "ses_one", permission: kind,
    patterns: ["report.pdf", "file-send-request:opaque"], always: remember.length ? ["file-send:opaque"] : [],
    metadata: { paths: ["report.pdf"], target: "Gmail draft to sam@example.com", connectionId: "google-workspace", fileSend: { kind, remember } }, receivedAt: 1, protocol: "v2" });

  test("each tool offers the same three choices the host said it will honor", () => {
    for (const kind of kinds) {
      const html = renderToStaticMarkup(<PermissionApprovalPanel permission={send(kind, ["session", "always"])} respondPermission={() => {}} />);
      for (const label of ["Deny", "Allow once", "Allow for this chat", "Always allow"]) expect(html).toContain(label);
      expect(html).toContain("report.pdf → Gmail draft to sam@example.com → google-workspace");
      expect(html).not.toContain("file-send-request:opaque");
      expect(html).not.toContain("Allow for session");
    }
  });
  test("choices the host will not remember are not offered", () => {
    const chat = renderToStaticMarkup(<PermissionApprovalPanel permission={send("drive_upload_file", ["session"])} respondPermission={() => {}} />);
    expect(chat).toContain("Allow for this chat");
    expect(chat).not.toContain("Always allow</button>");
    const once = renderToStaticMarkup(<PermissionApprovalPanel permission={send("drive_upload_file", [])} respondPermission={() => {}} />);
    expect(once).toContain("Allow once");
    expect(once).not.toContain("Allow for this chat");
    expect(once).toContain("This approval covers this send only.");
  });
});
