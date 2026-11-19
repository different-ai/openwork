"use client";

import { useState, type ReactNode } from "react";

import { DemoMenu, focusRing } from "./lp-demo-ui";
import { GoogleDriveMark, LinearMark, SkillMark, SlackMark } from "./lp-service-marks";

type Kind = "Skill" | "Connector" | "Plugin";
type Filter = "All" | "Connectors" | "Skills" | "Plugins";
type Item = { id: string; mark: ReactNode; name: string; kind: Kind; caption: string; source: "org" | "mine"; needsSignIn?: boolean };

const FILTER_KIND: Record<Filter, Kind | null> = { All: null, Connectors: "Connector", Skills: "Skill", Plugins: "Plugin" };
const FILTERS: Filter[] = ["All", "Connectors", "Skills", "Plugins"];

const PLUGIN_MARK = (
  <span className="flex h-5 w-5 items-center justify-center rounded-md bg-[#FFF4E5] text-[10px] font-semibold text-[#B45309]" aria-hidden="true">
    S
  </span>
);

const INITIAL: Item[] = [
  { id: "weekly", mark: <SkillMark className="h-5 w-5" />, name: "Weekly update", kind: "Skill", caption: "From Acme Studio", source: "org" },
  { id: "linear", mark: <LinearMark className="h-5 w-5" />, name: "Linear", kind: "Connector", caption: "From Acme Studio", source: "org" },
  { id: "drive", mark: <GoogleDriveMark className="h-5 w-5" />, name: "Google Drive", kind: "Connector", caption: "From Acme Studio", source: "org" },
  { id: "slack", mark: <SlackMark className="h-5 w-5" />, name: "Slack", kind: "Connector", caption: "From Acme Studio", source: "org", needsSignIn: true },
  { id: "sales", mark: PLUGIN_MARK, name: "Sales toolkit", kind: "Plugin", caption: "From Acme Studio", source: "org" },
  { id: "brand", mark: <SkillMark className="h-5 w-5" />, name: "Brand voice", kind: "Skill", caption: "Just me", source: "mine" },
  { id: "invoice", mark: <SkillMark className="h-5 w-5" />, name: "Invoice cleanup", kind: "Skill", caption: "Just me", source: "mine" }
];

type AddOption = { id: string; label: string; kind: Kind; name: string };

const ADD_OPTIONS: AddOption[] = [
  { id: "skill", label: "Create a skill", kind: "Skill", name: "New skill" },
  { id: "connector", label: "Connect a service", kind: "Connector", name: "Notion" },
  { id: "plugin", label: "Import a plugin", kind: "Plugin", name: "Research plugin" }
];

export function LibraryView() {
  const [items, setItems] = useState<Item[]>(INITIAL);
  const [filter, setFilter] = useState<Filter>("All");
  const [query, setQuery] = useState("");
  const [signingIn, setSigningIn] = useState<string | null>(null);

  const visible = items.filter((item) => {
    const kind = FILTER_KIND[filter];
    if (kind && item.kind !== kind) return false;
    return item.name.toLowerCase().includes(query.trim().toLowerCase());
  });
  const org = visible.filter((item) => item.source === "org");
  const mine = visible.filter((item) => item.source === "mine");
  const mineTotal = items.filter((item) => item.source === "mine").length;

  const signIn = (id: string) => {
    setSigningIn(id);
    window.setTimeout(() => {
      setItems((current) => current.map((item) => (item.id === id ? { ...item, needsSignIn: false } : item)));
      setSigningIn(null);
    }, 900);
  };

  const add = (optionId: string) => {
    const option = ADD_OPTIONS.find((entry) => entry.id === optionId);
    if (!option) return;
    const count = items.filter((item) => item.name.startsWith(option.name)).length;
    const mark = option.kind === "Skill" ? <SkillMark className="h-5 w-5" /> : option.kind === "Plugin" ? PLUGIN_MARK : <span className="flex h-5 w-5 items-center justify-center rounded-md border border-[#111] text-[10px] font-semibold" aria-hidden="true">N</span>;
    setItems((current) => [
      ...current,
      { id: `${option.id}-${current.length}`, mark, name: count ? `${option.name} ${count + 1}` : option.name, kind: option.kind, caption: "Just me", source: "mine" }
    ]);
    setFilter("All");
    setQuery("");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto px-5 py-5 md:px-7">
      <div className="flex items-center justify-between">
        <h3 className="text-xl font-semibold tracking-[-0.02em] text-[#111827]">Library</h3>
        <DemoMenu
          label="Add to library"
          trigger={<span>Add to library</span>}
          items={ADD_OPTIONS.map((option) => ({ id: option.id, label: option.label }))}
          onSelect={add}
          placement="bottom"
          align="end"
          triggerClassName={`flex h-8 items-center rounded-lg bg-[var(--lp-ink)] px-3.5 text-xs text-white hover:opacity-90 ${focusRing}`}
        />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {FILTERS.map((entry) => (
          <button
            key={entry}
            type="button"
            aria-pressed={filter === entry}
            onClick={() => setFilter(entry)}
            className={`flex h-7 items-center rounded-full px-3 text-xs transition-colors duration-150 ${focusRing} ${filter === entry ? "bg-[var(--lp-ink)] text-white" : "bg-[#F3F4F6] text-[#374151] hover:bg-[#E9EBEE]"}`}
          >
            {entry}
          </button>
        ))}
        <span className="flex-1" />
        <label className="sr-only" htmlFor="demo-library-filter">Filter by name</label>
        <input
          id="demo-library-filter"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter by name"
          className="hidden h-[30px] w-[200px] rounded-lg px-2.5 text-xs text-[#111827] shadow-[0_0_0_1px_#E5E7EB] placeholder:text-[#9AA2AE] focus:shadow-[0_0_0_1.5px_var(--lp-ink)] focus:outline-none sm:block"
        />
      </div>
      {org.length ? <Group title="From OpenWork" meta={`${org.length} shared with you`} items={org} signingIn={signingIn} onSignIn={signIn} /> : null}
      {mine.length ? <Group title="Added by you" meta={`${mineTotal} · only you so far`} items={mine} signingIn={signingIn} onSignIn={signIn} /> : null}
      {!org.length && !mine.length ? (
        <p className="py-10 text-center text-[13px] text-[#6B7280]">Nothing matches “{query}”. Try another name.</p>
      ) : null}
    </div>
  );
}

function Group({ title, meta, items, signingIn, onSignIn }: { title: string; meta: string; items: Item[]; signingIn: string | null; onSignIn: (id: string) => void }) {
  return (
    <div className="flex flex-col">
      <div className="flex justify-between border-b border-[var(--lp-border)] pb-1.5 text-xs">
        <span className="font-medium text-[#374151]">{title}</span>
        <span className="text-[#6B7280]">{meta}</span>
      </div>
      {items.map((item) => (
        <div key={item.id} className="flex h-[52px] items-center gap-3 border-b border-[#F0F1F3]">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#F7F8FA]">{item.mark}</span>
          <span className="flex w-[150px] shrink-0 items-center gap-1.5 text-[13px] font-medium text-[#111827] md:w-[190px]">
            {item.name}
            {item.needsSignIn ? null : <span className="h-1.5 w-1.5 rounded-full bg-[var(--lp-status-dot)]" aria-label="Ready" />}
          </span>
          <span className="hidden w-[84px] shrink-0 text-xs text-[#6B7280] sm:block">{item.kind}</span>
          <span className="flex-1 truncate text-xs text-[#6B7280]">{item.caption}</span>
          <span className="flex w-[96px] shrink-0 justify-end">
            {item.needsSignIn ? (
              <button
                type="button"
                onClick={() => onSignIn(item.id)}
                disabled={signingIn === item.id}
                className={`flex h-7 items-center rounded-lg px-3 text-xs text-[#374151] shadow-[0_0_0_1px_#E5E7EB] hover:bg-[#F7F8FA] disabled:text-[#6B7280] ${focusRing}`}
              >
                {signingIn === item.id ? "Signing in…" : "Sign in"}
              </button>
            ) : null}
          </span>
        </div>
      ))}
    </div>
  );
}
