/*
 * The org/admin page system, one place. Computers is the reference page:
 * - Column: DASHBOARD_PAGE_CLASS (1200px, px-6 md:px-8, py-8), compact 20px title, one muted state line.
 * - Lists: the Computers rows (`_features/computers/computer-rows.tsx`: RowList, RowListHeader, ListRow, RowLane), flat on the page.
 * - Cards (summaries, charts, grouped content that is not a list): AUTOMATION_CARD_CLASS, the My Automations card.
 * - Section titles: SECTION_TITLE_CLASS. Card titles: CARD_TITLE_CLASS.
 * - Settings: rule-titled sections of label-left, control-right rows inside SETTINGS_MEASURE_CLASS; a save bar only while something is unsaved.
 * - Toolbars and settings rows: 32px controls (FilterInput, DenSelect size="sm", DenButton size="sm").
 */

/** Computers is the reference column for org/admin pages. */
export const DASHBOARD_PAGE_CLASS = "mx-auto w-full max-w-[1200px] px-6 py-8 md:px-8";

/** Automations' quiet card surface; shared by analytics, gateway and settings instead of another card. */
export const AUTOMATION_CARD_CLASS = "rounded-2xl border border-[var(--den-shell-line)] bg-[var(--den-shell-topbar)]";

/** A section heading inside a page ("Providers", "Models", "Allowed desktop versions"). */
export const SECTION_TITLE_CLASS = "text-[13px] font-medium leading-5 text-[var(--dls-text-primary)]";

/** The title inside a card ("Daily active users", "Weekly launch update"). */
export const CARD_TITLE_CLASS = "text-[14px] font-semibold leading-5 tracking-[-0.01em] text-[var(--dls-text-primary)]";

/** 32px text field for toolbars and settings rows; `!` because DenInput's 42px default has no class merging. */
export const COMPACT_INPUT_CLASS = "h-8! px-3! text-[13px]!";

/**
 * Settings, an item's page, a form or a step (label left, value right) keep this measure, so the eye does not cross
 * the whole page. It sits in the middle of the page, as the lists' column does, so it is not left-heavy on a wide window.
 */
export const SETTINGS_MEASURE_CLASS = "mx-auto w-full max-w-[760px]";
