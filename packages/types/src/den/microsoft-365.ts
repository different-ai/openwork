export type Microsoft365Feature =
  | "mailRead"
  | "mailDraft"
  | "calendarRead"
  | "calendarWrite"
  | "filesRead"
  | "filesWrite"
  | "filesReadAll"
  | "filesFull"
  | "teamsChatRead"
  | "teamsChatSend"

export const MICROSOFT_365_DEFAULT_FEATURES: readonly Microsoft365Feature[] = [
  "mailRead",
  "calendarRead",
  "filesRead",
]

export const MICROSOFT_365_FEATURES: readonly Microsoft365Feature[] = [
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
]
