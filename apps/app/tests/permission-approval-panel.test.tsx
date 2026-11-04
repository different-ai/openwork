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
