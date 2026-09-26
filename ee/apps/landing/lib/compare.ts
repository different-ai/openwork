/** A comparison cell: `true` renders a check, `false` a dash, a string renders as-is. */
export type CompareCell = boolean | string;

export type CompareSource = { label: string; href: string };

export type CompareIcon = "cpu" | "key" | "monitor" | "users" | "cloud" | "route" | "library" | "migrate";

export type CompareCard = {
  icon: CompareIcon;
  title: string;
  link: { label: string; href: string };
};

export type CompareColumn<Key extends string> = { key: Key; label: string };

export type CompareRow<Key extends string> = { label: string } & Record<Key, CompareCell>;

export function compareCellText(cell: CompareCell): string {
  if (cell === true) return "Yes";
  if (cell === false) return "No";
  return cell;
}

/** Renders a comparison as a GitHub-flavoured markdown table for agent views. */
export function compareMarkdownTable<Key extends string>(columns: CompareColumn<Key>[], rows: CompareRow<Key>[]): string {
  const header = `| | ${columns.map((column) => column.label).join(" | ")} |`;
  const divider = `|---|${columns.map(() => "---").join("|")}|`;
  const body = rows.map((row) => `| ${row.label} | ${columns.map((column) => compareCellText(row[column.key])).join(" | ")} |`);
  return [header, divider, ...body].join("\n");
}

export function sourcesMarkdown(sources: CompareSource[]): string {
  return sources.map((source) => `[${source.label}](${source.href})`).join(", ");
}
