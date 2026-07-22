export const DESKTOP_NOTIFICATION_PREFERENCE_VALUES = ["off", "important", "all"] as const;

export type DesktopNotificationPreference =
  (typeof DESKTOP_NOTIFICATION_PREFERENCE_VALUES)[number];

export const DEFAULT_DESKTOP_NOTIFICATION_PREFERENCE: DesktopNotificationPreference = "off";

export function isDesktopNotificationPreference(
  value: unknown,
): value is DesktopNotificationPreference {
  return value === "off" || value === "important" || value === "all";
}
