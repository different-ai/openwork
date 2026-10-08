/**
 * Calendar logic shared by the desktop app and Workbot: time and DST helpers,
 * the normalized CalendarEvent with Google and Outlook adapters over Den's
 * calendar routes, Automation blocks reconciled from runs and schedules,
 * overlap layout and formatting. No UI; each app renders its own grid.
 */
export * from "./adapters"
export * from "./automation-items"
export * from "./den-contract"
export * from "./event"
export * from "./format"
export * from "./layout"
export * from "./runs"
export * from "./slot"
export * from "./time"
