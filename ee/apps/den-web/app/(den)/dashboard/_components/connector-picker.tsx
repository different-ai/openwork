"use client";

import { Plus, Server } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { FilterInput, ItemPanel, ItemRow, LinkButton } from "./item-list";
import { ConnectorLogo } from "./item-logo";
import type { ExternalMcpPreset } from "./mcp-connections-data";

/** Catalog copy is written for admins; members get the first plain clause. */
export function shortDescription(text: string): string {
  const first = text.split(/\s[—–-]\s|—|\.\s/)[0]?.trim() ?? "";
  return first.replace(/\.$/, "");
}

export type CatalogEntry = {
  id: string;
  name: string;
  description: string;
  url: string;
  /** Where the row goes when this is already set up. */
  openHref?: string;
};

export function catalogEntriesFromPresets(presets: readonly ExternalMcpPreset[]): CatalogEntry[] {
  return presets.map((preset) => ({
    id: preset.presetId,
    name: preset.displayName,
    description: shortDescription(preset.description),
    url: preset.url,
  }));
}

function ServerTile() {
  return (
    <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[7px] border border-gray-200 bg-white text-gray-500">
      <Server className="h-4 w-4" strokeWidth={1.8} />
    </span>
  );
}

function AddMcpForm({ initialName, onCancel, onContinue }: {
  initialName: string;
  onCancel: () => void;
  onContinue: (input: { name: string; url: string }) => void;
}) {
  const [name, setName] = useState(initialName);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const trimmedUrl = url.trim();
    try {
      const parsed = new URL(trimmedUrl);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("bad protocol");
    } catch {
      setError("Paste the full address, starting with https://");
      return;
    }
    const fallbackName = (() => {
      try {
        return new URL(trimmedUrl).hostname.replace(/^(www|mcp|api)\./, "").split(".")[0] ?? "";
      } catch {
        return "";
      }
    })();
    const finalName = name.trim() || fallbackName.charAt(0).toUpperCase() + fallbackName.slice(1);
    onContinue({ name: finalName || "MCP server", url: trimmedUrl });
  }

  return (
    <div className="rounded-2xl border border-gray-100 bg-white px-5 py-4" data-testid="connector-picker-custom">
      <div className="flex items-center gap-3.5">
        <ServerTile />
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-medium leading-5 text-gray-900">Add another MCP</p>
          <p className="text-[13px] leading-[18px] text-gray-500">Paste the address your vendor or IT team gave you.</p>
        </div>
      </div>
      <form
        className="mt-3 flex flex-col gap-2 pl-[46px]"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <DenInput value={url} onChange={(event) => { setUrl(event.target.value); setError(null); }} placeholder="https://mcp.example.com/mcp" aria-label="Address" autoFocus />
        <DenInput value={name} onChange={(event) => setName(event.target.value)} placeholder="Name (optional)" aria-label="Name" />
        {error ? <p className="text-[12px] text-red-600">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <DenButton type="button" variant="secondary" size="sm" onClick={onCancel}>Cancel</DenButton>
          <DenButton type="submit" size="sm">Continue</DenButton>
        </div>
      </form>
    </div>
  );
}

/** The one connector catalog, used from My Library and from Manage. */
export function ConnectorPicker({ entries, loading, addHref, customHref }: {
  entries: CatalogEntry[];
  loading: boolean;
  addHref: (entry: CatalogEntry) => string;
  customHref: (input: { name: string; url: string }) => string;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [customName, setCustomName] = useState<string | null>(null);
  const needle = query.trim().toLowerCase();
  const visible = entries.filter((entry) => !needle || `${entry.name} ${entry.description}`.toLowerCase().includes(needle));
  const noMatch = !loading && visible.length === 0 && needle.length > 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <FilterInput value={query} onChange={setQuery} size="md" className="flex-1" />
        <DenButton variant="secondary" size="sm" icon={Plus} className="h-9" onClick={() => setCustomName("")}>
          Add another MCP
        </DenButton>
      </div>
      {customName !== null ? (
        <AddMcpForm
          key={customName}
          initialName={customName}
          onCancel={() => setCustomName(null)}
          onContinue={(input) => router.push(customHref(input))}
        />
      ) : null}
      {noMatch && customName !== null ? null : <ItemPanel>
        {loading ? <p className="px-5 py-6 text-[13px] text-gray-500">Loading...</p> : null}
        {visible.map((entry) => (
          <ItemRow
            key={entry.id}
            testId={`connector-picker-${entry.id}`}
            logo={<ConnectorLogo name={entry.name} url={entry.url} />}
            title={entry.name}
            description={entry.description}
            action={entry.openHref ? (
              <LinkButton size="xs" href={entry.openHref} aria-label={`Open ${entry.name}`}>Open</LinkButton>
            ) : (
              <LinkButton size="xs" href={addHref(entry)} aria-label={`Add ${entry.name}`}>Add</LinkButton>
            )}
          />
        ))}
        {noMatch ? (
          <div className="flex flex-col items-center gap-1.5 px-6 pb-8 pt-10 text-center" data-testid="connector-picker-no-match">
            <ServerTile />
            <p className="mt-2.5 text-[15px] font-semibold leading-[22px] text-gray-900">No app called &ldquo;{query.trim()}&rdquo;</p>
            <p className="text-[13px] leading-5 text-gray-500">Add it with the address your vendor or IT team gave you.</p>
            <DenButton size="md" icon={Plus} className="mt-3.5" data-testid="connector-picker-no-match-add" onClick={() => setCustomName(query.trim())}>
              Add another MCP
            </DenButton>
          </div>
        ) : null}
      </ItemPanel>}
    </div>
  );
}
