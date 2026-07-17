import { describe, expect, test } from "bun:test";
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
});
