import { isDesktopRuntime } from "./runtime-env";

const ENV_FEEDBACK_URL = String(import.meta.env.VITE_OPENWORK_FEEDBACK_URL ?? "").trim();
const ENV_APP_VERSION = String(import.meta.env.VITE_OPENWORK_APP_VERSION ?? "").trim();
const ENV_BUILD_SHA = String(import.meta.env.VITE_OPENWORK_BUILD_SHA ?? "").trim();

export const DEFAULT_FEEDBACK_URL =
  ENV_FEEDBACK_URL || "https://openworklabs.com/feedback";

type FeedbackUrlOptions = {
  entrypoint: string;
  deployment?: "desktop" | "web";
  appVersion?: string | null;
  buildSha?: string | null;
  openworkServerVersion?: string | null;
  opencodeVersion?: string | null;
};

type ClientOsContext = {
  osName?: string;
  osVersion?: string;
  platform?: string;
};

function parseClientOsContext(): ClientOsContext {
  if (typeof navigator === "undefined") return {};

  const platform =
    typeof (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
      ?.platform === "string"
      ? (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform?.trim() ?? ""
      : typeof navigator.platform === "string"
        ? navigator.platform.trim()
        : "";
  const userAgent =
    typeof navigator.userAgent === "string" ? navigator.userAgent : "";

  const macMatch = userAgent.match(/Mac OS X ([0-9_]+)/i);
  if (macMatch) {
    return {
      osName: "macOS",
      osVersion: macMatch[1]?.replace(/_/g, "."),
      platform,
    };
  }

  const windowsMatch = userAgent.match(/Windows NT ([0-9.]+)/i);
  if (windowsMatch) {
    const rawVersion = windowsMatch[1] ?? "";
    const mappedVersion =
      rawVersion === "10.0" ? "10/11" : rawVersion || undefined;
    return {
      osName: "Windows",
      osVersion: mappedVersion,
      platform,
    };
  }

  const iosMatch = userAgent.match(/(?:iPhone|iPad|iPod).*OS ([0-9_]+)/i);
  if (iosMatch) {
    return {
      osName: "iOS",
      osVersion: iosMatch[1]?.replace(/_/g, "."),
      platform,
    };
  }

  const androidMatch = userAgent.match(/Android ([0-9.]+)/i);
  if (androidMatch) {
    return {
      osName: "Android",
      osVersion: androidMatch[1],
      platform,
    };
  }

  if (/Linux/i.test(userAgent) || /Linux/i.test(platform)) {
    return {
      osName: "Linux",
      platform,
    };
  }

  return platform ? { platform } : {};
}

export function buildFeedbackUrl(options: FeedbackUrlOptions): string {
  const url = new URL(DEFAULT_FEEDBACK_URL);
  const osContext = parseClientOsContext();
  const deployment = options.deployment ?? (isDesktopRuntime() ? "desktop" : "web");
  const version = options.appVersion?.trim() || ENV_APP_VERSION;
  const buildSha = options.buildSha?.trim() ?? ENV_BUILD_SHA;
  // Web releases are identified by the UI bundle's commit, independently of
  // the desktop package and the connected server's version.
  const appVersion = deployment === "web"
    ? (buildSha ? `web@${buildSha}` : "")
    : (/^0\.0\.0(?:$|[-+])/.test(version) ? "" : version);

  url.searchParams.set("source", "openwork-app");
  url.searchParams.set("entrypoint", options.entrypoint);

  const entries = {
    deployment,
    appVersion,
    openworkServerVersion: options.openworkServerVersion?.trim() ?? "",
    opencodeVersion: options.opencodeVersion?.trim() ?? "",
    osName: osContext.osName?.trim() ?? "",
    osVersion: osContext.osVersion?.trim() ?? "",
    platform: osContext.platform?.trim() ?? "",
  };

  for (const [key, value] of Object.entries(entries)) {
    if (value) {
      url.searchParams.set(key, value);
    }
  }

  return url.toString();
}
