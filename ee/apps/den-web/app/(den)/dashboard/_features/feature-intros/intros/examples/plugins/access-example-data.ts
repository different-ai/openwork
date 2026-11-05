/** Sample data only: no API calls (DESIGN.md I7). */

export const accessExamplePlugin = { name: "Sales playbook", inside: "4 skills, 2 commands" };

/** As "Who can use it" lists them on a plugin's page. */
export const accessExampleWho: ReadonlyArray<{ initials: string; name: string; detail: string }> = [
  { initials: "SA", name: "Sales", detail: "Team, 12 people" },
  { initials: "CS", name: "Customer Success", detail: "Team, 5 people" },
  { initials: "SL", name: "Sam Lee", detail: "Partnerships" },
];

/** Where they find it once shared. */
export const accessExampleWhere = "In their Library in OpenWork, nothing to install";
