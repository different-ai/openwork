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
      "mailSend",
      "mailManage",
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
      "Mail.Send",
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

  test("setup and edits load and save the selected Microsoft client, using the alias only for catalog setup", () => {
    const native = readFileSync(new URL("../app/(den)/dashboard/_components/native-provider-setup.tsx", import.meta.url), "utf8");
    const page = readFileSync(new URL("../app/(den)/dashboard/_components/admin-connector-page-screen.tsx", import.meta.url), "utf8");
    expect(native).toContain("useNativeProviderClient(clientProviderId, true)");
    expect(native).toContain("saveClient.mutateAsync({ providerId: clientProviderId, ...credentials, features })");
    expect(native).toContain("clientProviderId={providerKey}");
    expect(page).toContain("clientProviderId={connection.id}");
  });
});
