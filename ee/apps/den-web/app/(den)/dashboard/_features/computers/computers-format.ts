import type { z } from "zod";
import {
  REMOTE_DEVICE_AVAILABILITIES,
  REMOTE_DEVICE_KINDS,
  REMOTE_DEVICE_PROVIDERS,
  organizationComputerListResponseSchema,
  organizationComputerDetailResponseSchema,
  type RemoteDeviceAvailability,
  type RemoteDeviceComputerReadiness,
  type RemoteDeviceEventActor,
  type RemoteDeviceKind,
  type RemoteDevicePlatform,
  type RemoteDeviceProvider,
  type RemoteDeviceSource,
} from "@openwork/types/den/remote-devices";

export type OrganizationComputer = z.infer<typeof organizationComputerListResponseSchema>["devices"][number];
export type OrganizationComputerEvent = z.infer<typeof organizationComputerDetailResponseSchema>["events"][number];

/** Filters belong to the current organization, never a caller-supplied organization id. */
export type ComputerFilters = {
  search: string;
  kind: RemoteDeviceKind | "all";
  provider: RemoteDeviceProvider | "all";
  availability: RemoteDeviceAvailability | "all";
  page: number;
  instancePage: number;
  device: string;
};

type QueryReader = { get: (key: string) => string | null };
function oneOf<T extends string>(values: readonly T[], value: string | null): T | "all" {
  return values.find((entry) => entry === value) ?? "all";
}
export const parseDeviceKind = (value: string | null) => oneOf(REMOTE_DEVICE_KINDS, value);
export const parseDeviceProvider = (value: string | null) => oneOf(REMOTE_DEVICE_PROVIDERS, value);
export const parseDeviceAvailability = (value: string | null) => oneOf(REMOTE_DEVICE_AVAILABILITIES, value);

export function readComputerFilters(params: QueryReader): ComputerFilters {
  const page = params.get("page");
  const instancePage = params.get("instancePage");
  return {
    search: (params.get("search") ?? "").slice(0, 160),
    kind: parseDeviceKind(params.get("kind")),
    provider: parseDeviceProvider(params.get("provider")),
    availability: parseDeviceAvailability(params.get("availability")),
    page: page && /^[1-9]\d*$/.test(page) ? Math.min(999, Number(page)) : 1,
    instancePage: instancePage && /^[1-9]\d*$/.test(instancePage) ? Math.min(999, Number(instancePage)) : 1,
    device: params.get("device")?.trim() ?? "",
  };
}

export function writeComputerFilters(filters: ComputerFilters): string {
  const query = new URLSearchParams();
  if (filters.search) query.set("search", filters.search.slice(0, 160));
  if (filters.kind !== "all") query.set("kind", filters.kind);
  if (filters.provider !== "all") query.set("provider", filters.provider);
  if (filters.availability !== "all") query.set("availability", filters.availability);
  if (filters.page > 1) query.set("page", String(Math.min(999, filters.page)));
  if (filters.instancePage > 1) query.set("instancePage", String(Math.min(999, filters.instancePage)));
  if (filters.device) query.set("device", filters.device);
  return query.toString();
}

export function computerListPath(filters: ComputerFilters): string {
  const query = writeComputerFilters({ ...filters, search: filters.search.trim(), device: "" });
  return `/v1/org/computers${query ? `?${query}` : ""}`;
}
export function computerDetailPath(deviceId: string): string {
  return `/v1/org/computers/${encodeURIComponent(deviceId)}`;
}
export function hasComputerFilters(filters: ComputerFilters): boolean {
  return Boolean(filters.search.trim()) || filters.kind !== "all" || filters.provider !== "all" || filters.availability !== "all" || filters.page > 1;
}
export function clearComputerFilters(): ComputerFilters {
  return { search: "", kind: "all", provider: "all", availability: "all", page: 1, instancePage: 1, device: "" };
}

export function devicePageCount(total: number, pageSize: number): number {
  return pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1;
}

const whole = new Intl.NumberFormat("en-US");

/** "1 computer", "1,280 computers". */
export function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${whole.format(count)} ${count === 1 ? singular : plural}`;
}

/** "Never", "Just now", "2 min ago", "3 hours ago", "3 days ago". A time ahead of this clock reads as just now. */
export function relativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return "Never";
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "Unknown";
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${whole.format(days)} days ago`;
}

/** The full local date and time, for a `title`. */
export function absoluteTime(iso: string | null, locale?: string): string {
  if (!iso) return "";
  const time = new Date(iso);
  return Number.isFinite(time.getTime()) ? time.toLocaleString(locale, { dateStyle: "medium", timeStyle: "medium" }) : "";
}

/** Who the computer belongs to: their name, else their email, else everyone, else someone who has left. */
export function ownerLabel(device: Pick<OrganizationComputer, "owner" | "shared">): string {
  const name = device.owner?.name?.trim();
  if (name) return name;
  const email = device.owner?.email?.trim();
  if (email) return email;
  return device.shared ? "Shared with the organization" : "Former member";
}

export type DeviceTone = "success" | "warning" | "danger" | "neutral";

/** Green for online, amber for a computer that needs its owner; paused, offline and unchecked are normal and stay neutral. */
export const AVAILABILITY_TONE: Record<RemoteDeviceAvailability, DeviceTone> = {
  online: "success",
  needs_setup: "warning",
  paused: "neutral",
  offline: "neutral",
  unknown: "neutral",
};

export const KIND_LABELS: Record<RemoteDeviceKind, string> = { desktop: "Desktops", vm: "Virtual computers" };

export const PROVIDER_LABELS: Record<RemoteDeviceProvider, string> = {
  openwork_desktop: "OpenWork Desktop",
  workbot: "Workbot",
  freestyle: "Freestyle",
  daytona: "Daytona",
  mac_host: "Mac host",
  other: "Other",
};

export const SOURCE_LABELS: Record<RemoteDeviceSource, string> = {
  desktop_app: "Reported by OpenWork Desktop",
  workbot: "Reported by Workbot",
  manual: "Registered by a member",
};

const PLATFORM_LABELS: Record<RemoteDevicePlatform, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };
export const platformLabel = (platform: RemoteDevicePlatform | null): string => platform ? PLATFORM_LABELS[platform] : "Not reported";

export const ACTOR_LABELS: Record<RemoteDeviceEventActor, string> = { device: "Computer", workbot: "Workbot", member: "Member", system: "System" };

export const EVENT_LEVEL_TONE: Record<OrganizationComputerEvent["level"], DeviceTone> = { info: "neutral", warning: "warning", error: "danger" };
export const EVENT_LEVEL_LABELS: Record<OrganizationComputerEvent["level"], string> = { info: "Info", warning: "Warning", error: "Error" };

const READINESS_LABELS: Record<RemoteDeviceComputerReadiness, string> = {
  ready: "Ready",
  "setup-required": "Needs setup",
  unsupported: "Not supported",
  unavailable: "Unavailable",
};
export const readinessLabel = (readiness: RemoteDeviceComputerReadiness | null): string => readiness ? READINESS_LABELS[readiness] : "Not checked yet";
export const readinessTone = (readiness: RemoteDeviceComputerReadiness | null): DeviceTone =>
  readiness === "ready" ? "success" : readiness === "setup-required" ? "warning" : "neutral";

/** The fixed codes recorded with an event, as `[name, value]` pairs in the order they were stored. */
export function eventDataEntries(data: OrganizationComputerEvent["data"]): Array<[string, string]> {
  if (!data) return [];
  return Object.entries(data).map(([key, value]) => [key, value === null ? "none" : String(value)]);
}
