import type { PersonalAgentToolCatalog } from "@openwork/types/den/personal-agents";
import { Monitor, Plug } from "lucide-react";
import { useState } from "react";

import { OpenWorkMark } from "@/components/chat/capability-call-line";
import { composerConnectorLogoUrls } from "@/react-app/design-system/connector-logos";

const SIZES = {
  sm: { tile: "size-7 rounded-lg", mark: "size-4" },
  md: { tile: "size-10 rounded-xl", mark: "size-5" },
};

export function AgentConnectionLogo({ connectionId, name, size = "sm", muted = false }: {
  connectionId: string | null;
  name: string;
  size?: keyof typeof SIZES;
  muted?: boolean;
}) {
  const [failed, setFailed] = useState(0);
  const { tile, mark } = SIZES[size];
  const url = connectionId === "openwork" || connectionId === "computer" ? undefined : composerConnectorLogoUrls({ name })[failed];
  return (
    <span aria-hidden="true" data-agent-connection-logo={connectionId ?? name}
      className={`flex shrink-0 items-center justify-center border border-dls-border bg-dls-surface text-dls-text ${tile} ${muted ? "opacity-50 grayscale" : ""}`}>
      {connectionId === "openwork" ? <OpenWorkMark className={mark} />
        : connectionId === "computer" ? <Monitor className={mark} strokeWidth={1.8} />
          : url ? <img src={url} alt="" decoding="async" className={`${mark} object-contain`} onError={() => setFailed((current) => current + 1)} />
            : <Plug className={`${mark} text-dls-secondary`} strokeWidth={1.8} />}
    </span>
  );
}

export function agentConnectorIdentities(catalog: PersonalAgentToolCatalog | undefined) {
  return (catalog?.connections ?? []).map((connection) => ({
    id: `mcp:${connection.connectionId}`, name: connection.name, connectionId: connection.connectionId,
    iconUrl: composerConnectorLogoUrls({ name: connection.name })[0] ?? null, serviceUrl: null, toolNamespace: null,
  }));
}
