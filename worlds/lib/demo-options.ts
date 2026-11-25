export const DEMO_SEATS = ["demo", "practice", "backup"];
export const DEFAULT_DEMO_SOURCE = "release:0.18.71/cloud";
export const DEFAULT_DEMO_BUDGET = 30;
export const MAX_DEMO_LIFETIME = 1440;
export const MAX_DEMO_DISK = 40;

export function demoFlags(argv: readonly string[], known: readonly string[]) {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1];
    if (!flag || !known.includes(flag) || flags.has(flag) || !value || value.startsWith("--")) {
      throw new Error(`Use one value per flag, with no duplicates: ${known.join(", ")}.`);
    }
    flags.set(flag, value);
  }
  return flags;
}

export function demoSnapshotName(value: string | undefined): string {
  if (!value || !/^demo-desktop-[a-z0-9][a-z0-9-]{0,47}$/.test(value)) {
    throw new Error("Pass --snapshot demo-desktop-<lowercase-name> (letters, digits and dashes).");
  }
  return value;
}

export function demoSeat(value: string): string {
  if (!DEMO_SEATS.includes(value)) throw new Error("Demo seats are demo, practice and backup.");
  return value;
}

export function demoStage(value = "default"): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(value)) throw new Error("Invalid demo stage.");
  return value;
}

export type DemoSource = { kind: "release"; version: string; source: string } | { kind: "sha"; sha: string; source: string };

export function parseDemoSource(value: string): DemoSource {
  const release = /^release:(\d+\.\d+\.\d+)(?:\/(cloud))?$/.exec(value);
  if (release?.[1]) return { kind: "release", version: release[1], source: `release:${release[1]}/cloud` };
  const sha = /^sha:([a-f0-9]{40})$/.exec(value)?.[1];
  if (sha) return { kind: "sha", sha, source: `sha:${sha}` };
  throw new Error("Use --source release:<version>/cloud or sha:<full lowercase pushed SHA>.");
}

export function parseDemoOptions(argv: readonly string[]) {
  const flags = demoFlags(argv, ["--snapshot", "--seats", "--lifetime", "--timezone", "--budget-usd"]);
  const seats = flags.get("--seats")?.split(",").map(demoSeat) ?? [...DEMO_SEATS];
  if (new Set(seats).size !== seats.length) throw new Error("Do not repeat a demo seat.");
  const lifetime = flags.get("--lifetime") ?? "1440";
  if (!/^\d+$/.test(lifetime) || Number(lifetime) < 10 || Number(lifetime) > MAX_DEMO_LIFETIME) {
    throw new Error("--lifetime must be 10–1440 minutes.");
  }
  const timezone = flags.get("--timezone") ?? "America/Los_Angeles";
  if (!/^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2}$/.test(timezone)) throw new Error("Invalid IANA timezone.");
  new Intl.DateTimeFormat("en", { timeZone: timezone });
  const budget = flags.get("--budget-usd") ?? String(DEFAULT_DEMO_BUDGET);
  if (!/^\d+(?:\.\d{1,2})?$/.test(budget) || !Number.isFinite(Number(budget))) throw new Error("Invalid --budget-usd.");
  return { snapshot: demoSnapshotName(flags.get("--snapshot")), seats, lifetime: Number(lifetime), timezone, budget: Number(budget) };
}

export function demoInfrastructureUsd(seats: number, lifetime: number, diskGiB: number): number {
  return seats * (4 * 0.083 * lifetime / 60 + diskGiB * 0.0001 * lifetime / 60);
}

export function guardDemoBudget(options: ReturnType<typeof parseDemoOptions>, diskGiB: number): number {
  const estimate = demoInfrastructureUsd(options.seats.length, options.lifetime, diskGiB);
  if (estimate > options.budget) throw new Error(`Estimated infrastructure $${estimate.toFixed(2)} exceeds --budget-usd ${options.budget}; shorten the lifetime or raise the budget deliberately.`);
  return estimate;
}
