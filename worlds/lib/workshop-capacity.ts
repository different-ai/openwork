/** Each workshop sandbox comes from a fixed 4 CPU / 8 GiB / 10 GiB snapshot. */
export const WORKSHOP_SANDBOX = { cpu: 4, memoryGiB: 8, diskGiB: 10 } as const;
export const WORKSHOP_DAYTONA_ORG = process.env.WORKSHOP_DAYTONA_ORG?.trim() || "802dbb61-97d4-445a-9c80-e9255852a4e0";

export interface ContainerUsage { totalCpuQuota: number; totalMemoryQuota: number; totalDiskQuota: number; currentCpuUsage: number; currentMemoryUsage: number; currentDiskUsage: number }

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

/** Pure: how many more workshop sandboxes fit, and why the rest don't. */
export function capacityShortfall(usage: ContainerUsage, sandboxes: number): string | null {
  const need = { cpu: sandboxes * WORKSHOP_SANDBOX.cpu, memory: sandboxes * WORKSHOP_SANDBOX.memoryGiB, disk: sandboxes * WORKSHOP_SANDBOX.diskGiB };
  const free = { cpu: usage.totalCpuQuota - usage.currentCpuUsage, memory: usage.totalMemoryQuota - usage.currentMemoryUsage, disk: usage.totalDiskQuota - usage.currentDiskUsage };
  const fits = Math.max(0, Math.min(Math.floor(free.cpu / WORKSHOP_SANDBOX.cpu), Math.floor(free.memory / WORKSHOP_SANDBOX.memoryGiB), Math.floor(free.disk / WORKSHOP_SANDBOX.diskGiB)));
  if (need.cpu <= free.cpu && need.memory <= free.memory && need.disk <= free.disk) return null;
  return `Daytona quota fits ${fits} more workshop sandbox(es) but this launch needs ${sandboxes} (1 Den + ${sandboxes - 1} seats): CPU ${usage.currentCpuUsage}/${usage.totalCpuQuota}, memory ${usage.currentMemoryUsage}/${usage.totalMemoryQuota} GiB, disk ${usage.currentDiskUsage}/${usage.totalDiskQuota} GiB in use. Stop finished workshops or request more quota.`;
}

/** Fails before anything is created when the team's container quota can't hold the launch. */
export async function assertDaytonaCapacity(sandboxes: number, request: typeof fetch = fetch): Promise<void> {
  const key = process.env.DAYTONA_API_KEY?.trim();
  if (!key) throw new Error("DAYTONA_API_KEY is required to check workshop capacity.");
  const response = await request(`https://app.daytona.io/api/organizations/${encodeURIComponent(WORKSHOP_DAYTONA_ORG)}/usage`, {
    headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Could not read Daytona quota (HTTP ${response.status}).`);
  const body: unknown = await response.json();
  const regions = record(body) && Array.isArray(body.regionUsage) ? body.regionUsage.filter(record) : [];
  const usage = regions.find((region) => region.sandboxClass === "container" && region.regionId === "us");
  const read = (field: string): number => {
    const value = usage?.[field];
    if (typeof value !== "number") throw new Error("Daytona did not report container quota for the us region.");
    return value;
  };
  const shortfall = capacityShortfall({
    totalCpuQuota: read("totalCpuQuota"), totalMemoryQuota: read("totalMemoryQuota"), totalDiskQuota: read("totalDiskQuota"),
    currentCpuUsage: read("currentCpuUsage"), currentMemoryUsage: read("currentMemoryUsage"), currentDiskUsage: read("currentDiskUsage"),
  }, sandboxes);
  if (shortfall) throw new Error(shortfall);
}
