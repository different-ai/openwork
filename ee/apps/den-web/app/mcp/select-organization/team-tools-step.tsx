"use client";

import { Check, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SetupErrorLine, SetupLine, SetupPanelBody, SetupPanelTitle, SetupQuietButton, SetupSkeletonRows } from "../../(den)/_components/setup-frame-parts";
import { IntegrationIcon } from "../../(den)/dashboard/_components/integration-icon";
import type { ExternalMcpPreset } from "../../(den)/dashboard/_components/mcp-connections-data";
import { starterTeamToolConnection, starterTeamTools } from "../../(den)/dashboard/_components/starter-team-tools";

type Request = (path: string, init?: RequestInit) => Promise<{ response: Response; payload: unknown }>;

function parsePresets(payload: unknown): ExternalMcpPreset[] {
  if (typeof payload !== "object" || payload === null || !("presets" in payload) || !Array.isArray(payload.presets)) return [];
  return payload.presets.filter((preset): preset is ExternalMcpPreset =>
    typeof preset === "object" && preset !== null
    && typeof preset.presetId === "string" && typeof preset.displayName === "string"
    && typeof preset.url === "string" && typeof preset.authType === "string");
}

/**
 * A person who just created their workspace from Workbot's sign-in never sees Den's setup, so before Workbot opens
 * they can add the tools their team uses, the same starter tools as Den's Tools step. Workbot then offers each one
 * to connect on its welcome screen. Skipping is always fine.
 */
export function TeamToolsStep({ organizationId, request, onContinue }: {
  organizationId: string;
  request: Request;
  onContinue: () => void;
}) {
  const [presets, setPresets] = useState<ExternalMcpPreset[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Leave once: the sign-in continues from here, and its consent must not be sent twice.
  const left = useRef(false);
  const leave = () => {
    if (left.current) return;
    left.current = true;
    onContinue();
  };

  useEffect(() => {
    let cancelled = false;
    void request("/v1/mcp-connections/presets")
      .then(({ response, payload }) => { if (!cancelled) setPresets(response.ok ? starterTeamTools(parsePresets(payload)) : []); })
      .catch(() => { if (!cancelled) setPresets([]); });
    return () => { cancelled = true; };
  }, [request]);

  // Nothing to offer (or the list couldn't load): go straight on, as before.
  useEffect(() => {
    if (presets?.length === 0) leave();
  }, [presets]);

  function toggle(id: string) {
    if (adding || added.has(id)) return;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function addAndContinue() {
    const pending = (presets ?? []).filter((preset) => selected.has(preset.presetId) && !added.has(preset.presetId));
    setAdding(true);
    setError(null);
    const failed: string[] = [];
    for (const preset of pending) {
      const { response } = await request("/v1/mcp-connections", {
        method: "POST",
        headers: { "x-openwork-org-id": organizationId },
        body: JSON.stringify(starterTeamToolConnection(preset)),
      }).catch(() => ({ response: null }));
      if (response?.ok) setAdded((current) => new Set(current).add(preset.presetId));
      else failed.push(preset.displayName);
    }
    setAdding(false);
    if (failed.length) {
      setError(`Couldn't add ${failed.join(", ")}. Try again, or continue and add ${failed.length === 1 ? "it" : "them"} later.`);
      return;
    }
    leave();
  }

  if (!presets || presets.length === 0) return <SetupPanelBody><SetupPanelTitle>What do you work with?</SetupPanelTitle><SetupSkeletonRows /></SetupPanelBody>;

  const remaining = [...selected].filter((id) => !added.has(id)).length;
  const disabled = adding;
  return (
    <SetupPanelBody>
      <SetupPanelTitle>What do you work with?</SetupPanelTitle>
      <SetupLine muted>Add the tools your team uses and Workbot can help with them. Each person connects their own account.</SetupLine>
      <div className="grid max-h-[320px] gap-1.5 overflow-y-auto sm:grid-cols-2" aria-label="Team tools" data-testid="mcp-team-tools">
        {presets.map((preset) => {
          const done = added.has(preset.presetId);
          const chosen = selected.has(preset.presetId) || done;
          return (
            <button
              key={preset.presetId}
              type="button"
              aria-label={`Add ${preset.displayName}`}
              aria-pressed={chosen}
              disabled={disabled || done}
              onClick={() => toggle(preset.presetId)}
              className={`flex min-h-12 items-center gap-2.5 rounded-xl px-2.5 py-2 text-left ${chosen ? "bg-[var(--dls-hover)]" : "hover:bg-[var(--dls-hover)]"} disabled:cursor-default`}
            >
              <IntegrationIcon name={preset.displayName} serviceUrl={preset.url} className="size-7 shrink-0 rounded-lg" imageClassName="size-4" />
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--dls-text-primary)]">{preset.displayName}</span>
              {chosen ? <Check aria-hidden="true" className="size-4 shrink-0 text-[var(--dls-text-primary)]" strokeWidth={1.5} /> : null}
            </button>
          );
        })}
      </div>
      {error ? <SetupErrorLine>{error}</SetupErrorLine> : null}
      <div className="flex flex-col gap-3.5">
        <button type="button" className="den-button-primary w-full" disabled={disabled} onClick={() => (remaining > 0 ? void addAndContinue() : leave())}>
          {adding ? <><LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> Adding tools…</> : remaining > 0 ? `Add ${remaining} and open Workbot` : "Open Workbot"}
        </button>
        {remaining > 0 || error ? <SetupQuietButton className="self-center" disabled={disabled} onClick={leave}>Skip for now</SetupQuietButton> : null}
      </div>
    </SetupPanelBody>
  );
}
