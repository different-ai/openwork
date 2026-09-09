import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MICROSOFT_365_DEFAULT_FEATURES } from "@openwork/types/den/microsoft-365";
import {
  MICROSOFT_365_DISPLAY_SCOPES,
  MICROSOFT_365_PERMISSION_GROUPS,
} from "../app/(den)/dashboard/_components/microsoft-365-permissions";

describe("Microsoft 365 permission picker", () => {
  test("matches the Google-style capability groups with truthful Graph scopes", () => {
    expect(MICROSOFT_365_PERMISSION_GROUPS.map((group) => group.name)).toEqual([
      "Calendar",
      "Outlook",
      "OneDrive",
      "Teams",
    ]);
    expect(MICROSOFT_365_PERMISSION_GROUPS.flatMap((group) => group.permissions.map((permission) => permission.key))).toEqual([
      "calendarRead",
      "calendarWrite",
      "mailDraft",
      "mailRead",
      "filesRead",
      "filesWrite",
      "filesReadAll",
      "filesFull",
      "teamsChatRead",
      "teamsChatSend",
    ]);
    expect(MICROSOFT_365_DISPLAY_SCOPES).toEqual(new Set([
      "Calendars.Read",
      "Calendars.ReadWrite",
      "Mail.ReadWrite",
      "Mail.Read",
      "Files.Read",
      "Files.ReadWrite",
      "Files.Read.All",
      "Files.ReadWrite.All",
      "Chat.Read",
      "ChatMessage.Send",
    ]));
  });

  test("keeps write permissions opt-in", () => {
    expect(MICROSOFT_365_DEFAULT_FEATURES).toEqual(["mailRead", "calendarRead", "filesRead"]);
  });

  test("edits load and save the selected Microsoft client, using the alias only for catalog setup", () => {
    const screen = readFileSync(new URL("../app/(den)/dashboard/_components/mcp-connections-screen.tsx", import.meta.url), "utf8");
    const dialog = readFileSync(new URL("../app/(den)/dashboard/_components/microsoft-365-dialog.tsx", import.meta.url), "utf8");
    const edit = screen.slice(screen.indexOf("function editConnection("), screen.indexOf("function recoverConnection("));
    expect(edit).toContain("setMicrosoftDialogConnectionId(connection.id)");
    expect(edit).not.toContain("openQuickAdd(MICROSOFT_365_QUICK_ADD_ID)");
    expect(screen).toContain("setMicrosoftDialogConnectionId(MICROSOFT_365_QUICK_ADD_ID)");
    expect(screen).toContain("key={microsoftDialogConnectionId}");
    expect(screen).toContain("providerId={microsoftDialogConnectionId}");
    expect(screen).toContain("providerId: microsoftDialogConnectionId, ...input");
    expect(dialog).toContain("useNativeProviderClient(providerId, open)");
    expect(dialog).not.toContain('useNativeProviderClient("microsoft-365"');

    // Google's legacy alias path is unchanged; named connections retain their exact row for edits.
    expect(edit).toContain("if (connection.id === GOOGLE_WORKSPACE_QUICK_ADD_ID)");
    expect(edit).not.toContain('connection.nativeProviderKey === "google-workspace"');
    expect(edit).toContain("setEditingConnection(connection)");
    expect(screen).toContain("connectionId: connection.id,");
  });
});
