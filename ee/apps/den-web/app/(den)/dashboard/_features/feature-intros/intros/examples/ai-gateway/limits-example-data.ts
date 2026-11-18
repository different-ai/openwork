/** Sample data only: no API calls (DESIGN.md I7). */

export type LimitsExampleRow = {
  who: string;
  initials: string;
  amount: string;
  used: string;
  /** Share of the limit used, 0–100. */
  percent: number;
  whenReached: "Pauses them" | "Only warns";
};

export const limitsExampleRows: readonly LimitsExampleRow[] = [
  { who: "Engineering", initials: "EN", amount: "$200 a month", used: "$80", percent: 40, whenReached: "Pauses them" },
  { who: "Design", initials: "DE", amount: "$100 a month", used: "$85", percent: 85, whenReached: "Only warns" },
  { who: "Sam Lee", initials: "SL", amount: "$20 a day", used: "$20", percent: 100, whenReached: "Pauses them" },
];
