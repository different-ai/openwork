/** Sample data only: no API calls (DESIGN.md I7). */

export const overviewExampleTotal = "$391";

/** Daily spend in dollars for the last 14 days, oldest first. */
export const overviewExampleDaily: readonly number[] = [18, 22, 9, 6, 31, 35, 28, 40, 44, 12, 8, 47, 52, 39];

export const overviewExampleTopPeople: ReadonlyArray<{ name: string; initials: string; spend: string; value: number }> = [
  { name: "Maya Chen", initials: "MC", spend: "$128", value: 128 },
  { name: "Arjun Rao", initials: "AR", spend: "$94", value: 94 },
  { name: "Sam Lee", initials: "SL", spend: "$61", value: 61 },
];
