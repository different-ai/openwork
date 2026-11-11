import {
  REMOTE_DEVICE_AVAILABILITIES,
  REMOTE_DEVICE_KINDS,
  REMOTE_DEVICE_PROVIDERS,
  type AdminRemoteDevice,
  type AdminRemoteDeviceEvent,
  type RemoteDeviceAvailability,
  type RemoteDeviceComputerReadiness,
  type RemoteDeviceEventActor,
  type RemoteDeviceKind,
  type RemoteDevicePlatform,
  type RemoteDeviceProvider,
  type RemoteDeviceSource,
} from "@openwork/types/den/remote-devices";

/** What /admin › Devices is showing. `""` and `"all"` mean no filter. */
export type DeviceFilters = {
  organizationId: string;
  search: string;
  kind: RemoteDeviceKind | "all";
  provider: RemoteDeviceProvider | "all";
  availability: RemoteDeviceAvailability | "all";
  /** Only computers with a warning or error in the last 24 hours. */
  problems: boolean;
  page: number;
  /** The computer whose detail is open. */
  device: string;
};

/** The query keys that differ between the Devices page and an organization's Devices tab. */
export type DeviceQueryKeys = { search: string; page: string };
export const DEVICE_QUERY_KEYS: DeviceQueryKeys = { search: "search", page: "page" };
/** On an organization's page `search` and `page` belong to its members list and follow the admin from tab to tab. */
export const ORGANIZATION_DEVICE_QUERY_KEYS: DeviceQueryKeys = { search: "deviceSearch", page: "devicePage" };

const MAX_SEARCH_LENGTH = 160;
/** The API takes a page of at most three digits. */
const MAX_PAGE = 999;

type QueryReader = { get: (key: string) => string | null };

function oneOf<T extends string>(values: readonly T[], value: string | null): T | null {
  return values.find((entry) => entry === value) ?? null;
}

export function parseDeviceKind(value: string | null): RemoteDeviceKind | "all" {
  return oneOf(REMOTE_DEVICE_KINDS, value) ?? "all";
}

export function parseDeviceProvider(value: string | null): RemoteDeviceProvider | "all" {
  return oneOf(REMOTE_DEVICE_PROVIDERS, value) ?? "all";
}

export function parseDeviceAvailability(value: string | null): RemoteDeviceAvailability | "all" {
  return oneOf(REMOTE_DEVICE_AVAILABILITIES, value) ?? "all";
}

function readPage(value: string | null): number {
  if (!value || !/^[1-9]\d*$/.test(value)) return 1;
  const page = Number(value);
  return Number.isSafeInteger(page) ? Math.min(MAX_PAGE, page) : MAX_PAGE;
}

/** Filters from the address bar. `organizationId` is given when the list sits inside one organization's page. */
export function readDeviceFilters(params: QueryReader, keys: DeviceQueryKeys = DEVICE_QUERY_KEYS, organizationId?: string): DeviceFilters {
  return {
    organizationId: organizationId ?? params.get("organizationId")?.trim() ?? "",
    search: (params.get(keys.search) ?? "").slice(0, MAX_SEARCH_LENGTH),
    kind: parseDeviceKind(params.get("kind")),
    provider: parseDeviceProvider(params.get("provider")),
    availability: parseDeviceAvailability(params.get("availability")),
    problems: params.get("problems") === "true",
    page: readPage(params.get(keys.page)),
    device: params.get("device")?.trim() ?? "",
  };
}

/**
 * The query string for these filters, without the leading `?`. Parameters this list does not own are kept.
 * `fixedOrganization` leaves `organizationId` out: the organization comes from the path.
 */
export function writeDeviceFilters(current: string, filters: DeviceFilters, keys: DeviceQueryKeys = DEVICE_QUERY_KEYS, fixedOrganization = false): string {
  const query = new URLSearchParams(current);
  const set = (key: string, value: string) => { if (value) query.set(key, value); else query.delete(key); };
  if (!fixedOrganization) set("organizationId", filters.organizationId);
  set(keys.search, filters.search.slice(0, MAX_SEARCH_LENGTH));
  set("kind", filters.kind === "all" ? "" : filters.kind);
  set("provider", filters.provider === "all" ? "" : filters.provider);
  set("availability", filters.availability === "all" ? "" : filters.availability);
  set("problems", filters.problems ? "true" : "");
  set(keys.page, filters.page > 1 ? String(Math.min(MAX_PAGE, filters.page)) : "");
  set("device", filters.device);
  return query.toString();
}

/** The Den API path for one page of the list. */
export function deviceListPath(filters: DeviceFilters): string {
  const query = new URLSearchParams();
  if (filters.organizationId) query.set("organizationId", filters.organizationId);
  const search = filters.search.trim().slice(0, MAX_SEARCH_LENGTH);
  if (search) query.set("search", search);
  if (filters.kind !== "all") query.set("kind", filters.kind);
  if (filters.provider !== "all") query.set("provider", filters.provider);
  if (filters.availability !== "all") query.set("availability", filters.availability);
  if (filters.problems) query.set("problems", "true");
  if (filters.page > 1) query.set("page", String(Math.min(MAX_PAGE, filters.page)));
  return `/v1/admin/remote-devices${query.size ? `?${query}` : ""}`;
}

export function deviceDetailPath(deviceId: string): string {
  return `/v1/admin/remote-devices/${encodeURIComponent(deviceId)}`;
}

/** Whether "Clear filters" would change the list. A fixed organization is not a filter the admin chose here. */
export function hasDeviceFilters(filters: DeviceFilters, fixedOrganization = false): boolean {
  return Boolean(filters.search.trim()) || filters.kind !== "all" || filters.provider !== "all" || filters.availability !== "all"
    || filters.problems || filters.page > 1 || (!fixedOrganization && Boolean(filters.organizationId));
}

/** The same view with every filter off. The fixed organization and the open computer stay. */
export function clearDeviceFilters(filters: DeviceFilters, fixedOrganization = false): DeviceFilters {
  return { organizationId: fixedOrganization ? filters.organizationId : "", search: "", kind: "all", provider: "all", availability: "all", problems: false, page: 1, device: filters.device };
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
export function ownerLabel(device: Pick<AdminRemoteDevice, "owner" | "shared">): string {
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

export const EVENT_LEVEL_TONE: Record<AdminRemoteDeviceEvent["level"], DeviceTone> = { info: "neutral", warning: "warning", error: "danger" };
export const EVENT_LEVEL_LABELS: Record<AdminRemoteDeviceEvent["level"], string> = { info: "Info", warning: "Warning", error: "Error" };

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
export function eventDataEntries(data: AdminRemoteDeviceEvent["data"]): Array<[string, string]> {
  if (!data) return [];
  return Object.entries(data).map(([key, value]) => [key, value === null ? "none" : String(value)]);
}
