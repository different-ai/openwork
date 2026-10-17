const normalized = (value: string) => value.replace(/[*_`]/g, "").replace(/&nbsp;/g, " ").toLowerCase();

/** Verify a human-readable product table without depending on prose sentence order. */
export function comparisonRequirements(report: string, request: string): string[] {
  const failures: string[] = [];
  const rows = report.split(/\r?\n/).filter((line) => line.includes("|")).map((line) => line.split("|").map((cell) => normalized(cell.trim())));
  const header = rows.findIndex((cells) => cells.some((cell) => /atlas\s*2/.test(cell)) && cells.some((cell) => /atlas\s*lift/.test(cell)));
  if (header < 0) return ["Product one-pager needs a real comparison table with separate Atlas 2 and Atlas Lift columns"];
  const atlas = rows[header].findIndex((cell) => /atlas\s*2/.test(cell));
  const lift = rows[header].findIndex((cell) => /atlas\s*lift/.test(cell));
  const metric = (pattern: RegExp) => rows.slice(header + 1).find((cells) => cells.some((cell) => pattern.test(cell)));
  const payload = metric(/payload/), speed = metric(/speed/), runtime = metric(/runtime|run time|battery life/);
  if (!payload || !/\b300\s*(?:kg|kilogram)/.test(payload[atlas] ?? "") || !/\b1[,. ]?200\s*(?:kg|kilogram)/.test(payload[lift] ?? "")) failures.push("Product payloads must match their source columns: Atlas 2 300 kg, Atlas Lift 1,200 kg");
  if (!speed || !/\b2(?:\.0)?\s*m\s*\/\s*s/.test(speed[atlas] ?? "") || !/\b1\.5\s*m\s*\/\s*s/.test(speed[lift] ?? "")) failures.push("Product speed values must match their source columns");
  if (!runtime || !/\b10\s*(?:h|hours?)/.test(runtime[atlas] ?? "") || !/\b8\s*(?:h|hours?)/.test(runtime[lift] ?? "")) failures.push("Product runtime values must match their source columns");
  const customer = normalized(request), output = normalized(report);
  for (const [source, coverage, label] of [
    [/warehouse|picking/, /warehouse|picking|goods.to.person/, "warehouse/picking use case"],
    [/pallet/, /pallet/, "pallet use case"],
    [/sign.off|sign-off|approval/, /sign.off|sign-off|approval|unconfirmed/, "required customer sign-off"],
    [/training/, /training/, "operator training"],
    [/supervis|unattended/, /supervis|unattended/, "supervised operation"],
    [/charging/, /charging/, "charging-layout confirmation"],
    [/level.floor/, /level.floor|approved.route/, "approved level-floor routes"],
  ] as const) if (source.test(customer) && !coverage.test(output)) failures.push(`One-pager omitted the actual customer request's ${label}`);
  if (/production.ready|unattended operation is (?:safe|approved)|sign.off (?:is )?complete/.test(output)) failures.push("One-pager must not invent production readiness or completed safety sign-off");
  return failures;
}
