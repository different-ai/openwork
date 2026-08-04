/**
 * Automations ships with complete English copy in every locale while the
 * first translation pass is in progress. Keeping one shared map prevents a
 * partially translated locale from hiding the preview boundary.
 */
export const automationsEnglish = {
  "automations.preferences_title": "Automations",
  "automations.preferences_section_desc": "Preview repeatable work scheduled by Den and executed by this desktop.",
  "automations.preferences_toggle": "Automations (preview)",
  "automations.preferences_toggle_desc": "Show Automations in the app. Den keeps the schedule and this signed-in desktop executes eligible occurrences.",
} as const;
