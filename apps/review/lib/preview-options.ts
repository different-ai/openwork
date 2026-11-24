import type { EvidenceProviderId } from "@openwork/evidence-provider";
import type { PreviewWorld } from "@openwork/evidence-provider/review";

export interface PreviewProviderOption {
  id: EvidenceProviderId;
  label: string;
  connected: boolean;
  worlds: readonly PreviewWorld[];
  reason?: string;
}

export function previewAccessUrl(provider: EvidenceProviderId, value: string, desktop = false): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    if (provider === "daytona") return /^8080-[a-z0-9]+\.daytonaproxy\d{2}\.(?:net|eu)$/.test(url.hostname);
    return (desktop ? /^desktop-[a-f0-9]{32}\.(?:style\.dev|preview\.openwork\.software)$/
      : /^ow-[a-f0-9]{32}\.(?:style\.dev|preview\.openwork\.software)$/).test(url.hostname);
  } catch { return false; }
}
