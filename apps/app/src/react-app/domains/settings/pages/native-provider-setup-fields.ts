import {
  MICROSOFT_365_DEFAULT_FEATURES,
  type Microsoft365Feature,
} from "@openwork/types/den/microsoft-365";

export type NativeProviderKey = "google-workspace" | "microsoft-365";

type Permission<Key extends string = string> = {
  key: Key;
  label: string;
  scope: string;
  detail?: string;
};

type PermissionGroup<Key extends string = string> = {
  name: string;
  permissions: readonly Permission<Key>[];
};

const googlePermissions: readonly PermissionGroup[] = [
  { name: "Calendar", permissions: [
    { key: "calendarRead", label: "Read calendar", scope: "calendar.readonly" },
    { key: "calendarWrite", label: "Create, edit, and cancel calendar events", scope: "calendar.events" },
  ] },
  { name: "Gmail", permissions: [
    { key: "gmailDraft", label: "Create and edit email drafts", scope: "gmail.compose", detail: "Google grants compose access, including sending. OpenWork keeps draft creation and sending as separate features; this option does not enable sending." },
    { key: "gmailSend", label: "Send email drafts after confirmation", scope: "gmail.compose", detail: "Uses the same Google scope as drafts. Sending still requires an explicit request and confirmation." },
    { key: "gmailRead", label: "Read Gmail", scope: "gmail.readonly" },
    { key: "gmailManage", label: "Manage Gmail — send, archive, read status, labels, and trash", scope: "gmail.modify" },
    { key: "gmailLabels", label: "Create and manage Gmail labels", scope: "gmail.labels" },
  ] },
  { name: "Drive", permissions: [
    { key: "driveFile", label: "Work with selected Drive files", scope: "drive.file" },
    { key: "driveRead", label: "Read all Drive files", scope: "drive.readonly" },
    { key: "driveFull", label: "Full Drive access", scope: "drive" },
  ] },
  { name: "Sheets", permissions: [
    { key: "sheetsRead", label: "Read spreadsheets", scope: "spreadsheets.readonly" },
    { key: "sheetsWrite", label: "Create spreadsheets and edit cells", scope: "spreadsheets" },
  ] },
  { name: "Chat", permissions: [
    { key: "chat", label: "Google Chat", scope: "chat.spaces.readonly + chat.messages.readonly + chat.messages.create", detail: "Read spaces and messages, and send messages." },
  ] },
];

const microsoftPermissions: readonly PermissionGroup<Microsoft365Feature>[] = [
  { name: "Calendar", permissions: [
    { key: "calendarRead", label: "Read Outlook calendar", scope: "Calendars.Read" },
    { key: "calendarWrite", label: "Create and manage calendar events", scope: "Calendars.ReadWrite", detail: "Microsoft grants full access to the member's calendars." },
  ] },
  { name: "Outlook", permissions: [
    { key: "mailDraft", label: "Create and manage email drafts", scope: "Mail.ReadWrite", detail: "Microsoft grants mailbox read/write access. This option does not send mail." },
    { key: "mailRead", label: "Read Outlook mail", scope: "Mail.Read" },
    { key: "mailSend", label: "Send Outlook email", scope: "Mail.Send", detail: "Sending requires an explicit request and confirmation; a saved draft is not sent automatically." },
    { key: "mailManage", label: "Manage read status, categories, and mailbox folders", scope: "Mail.ReadWrite" },
  ] },
  { name: "OneDrive", permissions: [
    { key: "filesRead", label: "Read OneDrive files", scope: "Files.Read" },
    { key: "filesWrite", label: "Create and update OneDrive files", scope: "Files.ReadWrite" },
    { key: "filesReadAll", label: "Read all files the member can access", scope: "Files.Read.All" },
    { key: "filesFull", label: "Full access to files the member can access", scope: "Files.ReadWrite.All" },
  ] },
  { name: "Teams", permissions: [
    { key: "teamsChatRead", label: "Read Teams chats", scope: "Chat.Read" },
    { key: "teamsChatSend", label: "Send Teams chat messages", scope: "Chat.Read + ChatMessage.Send", detail: "Includes chat read access so OpenWork can find an existing chat; it cannot create a new chat." },
  ] },
];

export function nativeProviderPermissions(providerKey: NativeProviderKey): readonly PermissionGroup[] {
  return providerKey === "google-workspace" ? googlePermissions : microsoftPermissions;
}

export function nativeProviderDefaultFeatures(providerKey: NativeProviderKey): string[] {
  return providerKey === "google-workspace"
    ? ["calendarRead", "gmailDraft", "driveFile"]
    : [...MICROSOFT_365_DEFAULT_FEATURES];
}

export function selectNativeProviderFeatures(providerKey: NativeProviderKey, selected: readonly string[]): string[] {
  const allowed = new Set(nativeProviderPermissions(providerKey).flatMap((group) => group.permissions.map((permission) => permission.key)));
  return [...new Set(selected.filter((feature) => allowed.has(feature)))];
}

export type NativeProviderFields = {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  features: string[];
};

export function nativeProviderClientPayload(providerKey: NativeProviderKey, fields: NativeProviderFields) {
  const clientId = fields.clientId.trim();
  const clientSecret = fields.clientSecret.trim();
  const tenantId = fields.tenantId.trim();
  return {
    ...(clientId ? { clientId } : {}),
    ...(clientSecret ? { clientSecret } : {}),
    ...(providerKey === "microsoft-365" && tenantId ? { tenantId } : {}),
    features: selectNativeProviderFeatures(providerKey, fields.features),
  };
}
