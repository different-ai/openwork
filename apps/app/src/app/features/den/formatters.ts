export function denStatusBadgeClass(
  kind: "ready" | "warning" | "neutral" | "error",
) {
  switch (kind) {
    case "ready":
      return "border-green-7/30 bg-green-3/20 text-green-11";
    case "warning":
      return "border-amber-7/30 bg-amber-3/20 text-amber-11";
    case "error":
      return "border-red-7/30 bg-red-3/20 text-red-11";
    default:
      return "border-gray-6/60 bg-gray-3/20 text-gray-11";
  }
}

export function denWorkerStatusMeta(status: string) {
  const normalized = status.trim().toLowerCase();
  switch (normalized) {
    case "healthy":
    case "ready":
      return { label: "Ready", tone: "ready" as const, canOpen: true };
    case "provisioning":
    case "starting":
      return {
        label: "Provisioning",
        tone: "warning" as const,
        canOpen: false,
      };
    case "failed":
      return { label: "Failed", tone: "error" as const, canOpen: false };
    case "stopped":
    case "suspended":
      return { label: "Stopped", tone: "neutral" as const, canOpen: false };
    default:
      return {
        label: normalized
          ? `${normalized.slice(0, 1).toUpperCase()}${normalized.slice(1)}`
          : "Unknown",
        tone: "neutral" as const,
        canOpen: normalized === "ready",
      };
  }
}

export function formatDenMoneyMinor(
  amount: number | null,
  currency: string | null,
): string {
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    return "Not available";
  }

  const normalizedCurrency = (currency ?? "USD").toUpperCase();
  const majorValue = amount / 100;

  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: normalizedCurrency,
    }).format(majorValue);
  } catch {
    return `${majorValue.toFixed(2)} ${normalizedCurrency}`;
  }
}

export function formatDenIsoDate(value: string | null): string {
  if (!value) {
    return "Not available";
  }

  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "Not available";
    }
    return date.toLocaleDateString();
  } catch {
    return "Not available";
  }
}

export function formatDenRecurringInterval(
  interval: string | null,
  count: number | null,
): string {
  if (!interval) {
    return "billing cycle";
  }

  const normalizedInterval = interval.replace(/_/g, " ");
  const normalizedCount =
    typeof count === "number" && Number.isFinite(count) ? count : 1;
  if (normalizedCount <= 1) {
    return `per ${normalizedInterval}`;
  }

  const pluralSuffix = normalizedInterval.endsWith("s") ? "" : "s";
  return `every ${normalizedCount} ${normalizedInterval}${pluralSuffix}`;
}

export function formatDenSubscriptionStatus(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (!normalized) {
    return "Unknown";
  }

  return normalized
    .split("_")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
