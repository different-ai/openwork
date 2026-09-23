"use client";

import { Server } from "lucide-react";
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

function SomethingElse({ onContinue }: { onContinue: (input: { name: string; url: string }) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
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
    <div className="mx-2 my-1 rounded-xl border border-dashed border-gray-200 px-3 py-3" data-testid="connector-picker-custom">
      <div className="flex items-center gap-3.5">
        <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[7px] border border-gray-200 bg-white text-gray-500">
          <Server className="h-4 w-4" strokeWidth={1.8} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-medium leading-5 text-gray-900">Something else</p>
          <p className="text-[13px] leading-[18px] text-gray-500">Add an MCP server with the address your vendor or IT team gave you.</p>
        </div>
        {open ? null : (
          <DenButton variant="secondary" size="xs" onClick={() => setOpen(true)}>Add an MCP</DenButton>
        )}
      </div>
      {open ? (
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
            <DenButton type="button" variant="secondary" size="sm" onClick={() => { setOpen(false); setError(null); }}>Cancel</DenButton>
            <DenButton type="submit" size="sm">Continue</DenButton>
          </div>
        </form>
      ) : null}
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
  const needle = query.trim().toLowerCase();
  const visible = entries.filter((entry) => !needle || `${entry.name} ${entry.description}`.toLowerCase().includes(needle));

  return (
    <div className="flex flex-col gap-3">
      <FilterInput value={query} onChange={setQuery} size="md" />
      <ItemPanel>
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
        {!loading && visible.length === 0 && needle ? (
          <p className="px-5 py-4 text-[13px] text-gray-500">Nothing matches &quot;{query.trim()}&quot;.</p>
        ) : null}
        <SomethingElse onContinue={(input) => router.push(customHref(input))} />
      </ItemPanel>
    </div>
  );
}
