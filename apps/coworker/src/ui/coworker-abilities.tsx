import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { abilitySelected, readCoworkerAbilities, type AbilitySelection, type CoworkerAbilitiesCatalog } from "@/lib/abilities";
import { coworkerBridge, type CoworkerSummary } from "@/lib/bridge";
import { Button, ErrorNote, inputClass } from "@/ui/kit";
import { GroupLabel, QuietLine } from "@/ui/rows";

type AbilityOption = {
  id: string;
  name: string;
  description: string;
  source: string;
  detail: string;
  available: boolean;
  gateway?: boolean;
};

function sameSelection(left: AbilitySelection, right: AbilitySelection): boolean {
  return left.mode === right.mode && left.ids.length === right.ids.length && left.ids.every((id) => right.ids.includes(id));
}

export function CoworkerAbilitiesEditor({ coworker, onCoworkerChanged }: {
  coworker: CoworkerSummary;
  onCoworkerChanged: (coworker: CoworkerSummary) => void;
}) {
  const { slug, createdAt } = coworker;
  const [baseline, setBaseline] = useState(() => readCoworkerAbilities(coworker.abilities));
  const [draft, setDraft] = useState(baseline);
  const [catalog, setCatalog] = useState<CoworkerAbilitiesCatalog | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [readingSaved, setReadingSaved] = useState(true);
  const [catalogError, setCatalogError] = useState("");
  const [readError, setReadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const savingRef = useRef(false);
  const scopeRef = useRef({ active: false });
  const catalogRequestRef = useRef(0);
  const latestRef = useRef({ coworker, onCoworkerChanged });
  latestRef.current = { coworker, onCoworkerChanged };

  useLayoutEffect(() => {
    const scope = { active: true };
    scopeRef.current = scope;
    return () => { scope.active = false; };
  }, [slug, createdAt]);

  const refreshCatalog = useCallback(async () => {
    const scope = scopeRef.current;
    if (!scope.active || savingRef.current) return;
    const request = ++catalogRequestRef.current;
    setLoadingCatalog(true);
    setCatalogError("");
    try {
      const next = await coworkerBridge.abilities.catalog({ slug, createdAt });
      if (scope.active && request === catalogRequestRef.current) setCatalog(next);
    } catch (cause) {
      if (scope.active && request === catalogRequestRef.current) setCatalogError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (scope.active && request === catalogRequestRef.current) setLoadingCatalog(false);
    }
  }, [slug, createdAt]);

  useEffect(() => {
    void refreshCatalog();
  }, [refreshCatalog]);

  useEffect(() => {
    const scope = scopeRef.current;
    setReadingSaved(true);
    setReadError("");
    void coworkerBridge.coworkers.get(slug).then((current) => {
      if (!scope.active) return;
      if (current.slug !== slug || current.createdAt !== createdAt) throw new Error("This coworker was replaced. Reopen settings for the current coworker.");
      const latest = latestRef.current.coworker;
      const observed = readCoworkerAbilities(current.abilities);
      const lastKnown = readCoworkerAbilities(latest.abilities);
      const abilities = observed.revision >= lastKnown.revision ? observed : lastKnown;
      setBaseline(abilities);
      setDraft(abilities);
      if (JSON.stringify(lastKnown) !== JSON.stringify(abilities)) latestRef.current.onCoworkerChanged({ ...latest, abilities });
    }).catch((cause) => {
      if (scope.active) setReadError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (scope.active) setReadingSaved(false);
    });
  }, [slug, createdAt]);

  const dirty = !sameSelection(draft.skills, baseline.skills) || !sameSelection(draft.mcpServers, baseline.mcpServers);
  const latestSaved = readCoworkerAbilities(coworker.abilities);
  const stale = latestSaved.revision > baseline.revision;

  function change(group: "skills" | "mcpServers", update: (selection: AbilitySelection) => AbilitySelection) {
    if (savingRef.current || readingSaved) return;
    setDraft((current) => ({ ...current, [group]: update(current[group]) }));
    setSaved(false);
    setSaveError("");
  }

  function discard() {
    if (savingRef.current || readingSaved) return;
    const abilities = stale ? latestSaved : baseline;
    setBaseline(abilities);
    setDraft(abilities);
    setSaved(false);
    setSaveError("");
  }

  async function save() {
    const scope = scopeRef.current;
    if (!scope.active || savingRef.current || readingSaved || !dirty) return;
    if (readCoworkerAbilities(latestRef.current.coworker.abilities).revision > baseline.revision) {
      setSaveError("Abilities changed elsewhere. Review the latest saved selection before saving.");
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setSaved(false);
    setSaveError("");
    try {
      const updated = await coworkerBridge.abilities.update({ slug, createdAt, expectedRevision: baseline.revision, abilities: draft });
      if (!scope.active) return;
      if (updated.slug !== slug || updated.createdAt !== createdAt) throw new Error("The save response belongs to a different coworker.");
      const abilities = readCoworkerAbilities(updated.abilities);
      if (!updated.abilities || abilities.revision <= baseline.revision) throw new Error("The save did not confirm a new abilities revision.");
      if (!sameSelection(abilities.skills, draft.skills) || !sameSelection(abilities.mcpServers, draft.mcpServers)) throw new Error("The save response did not confirm the requested selection.");
      const latest = latestRef.current.coworker;
      if (readCoworkerAbilities(latest.abilities).revision > abilities.revision) throw new Error("Abilities changed again while saving. Review the latest saved selection.");
      setBaseline(abilities);
      setDraft(abilities);
      setSaved(true);
      setReadError("");
      latestRef.current.onCoworkerChanged({ ...latest, abilities });
    } catch (cause) {
      if (scope.active) setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      savingRef.current = false;
      if (scope.active) setSaving(false);
    }
  }

  const incomplete = Boolean(catalogError || catalog?.errors.length);
  const listProps = { loading: loadingCatalog, loaded: catalog !== null, incomplete };

  return (
    <div className="min-w-0 space-y-4 [overflow-wrap:anywhere]" data-testid="coworker-abilities">
      <p className="text-xs leading-relaxed text-mist">Choose skills and MCP servers for {coworker.name}'s normal tool calls. Changes are saved only with Save changes.</p>
      <p className="rounded-lg border border-amber/25 bg-amber/5 px-3 py-2 text-xs leading-relaxed text-amber">
        Tool selection only—not a security boundary. Terminal, files, browser/computer and delegation keep their existing access.
      </p>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] text-mist" role="status">{loadingCatalog ? "Reading catalog…" : "Catalog refreshes only on opening or Refresh."}</p>
        <Button type="button" variant="ghost" className="shrink-0 text-xs" disabled={loadingCatalog || saving} onClick={() => void refreshCatalog()}>Refresh</Button>
      </div>
      {catalogError ? <div role="alert"><ErrorNote>Catalog refresh failed. {catalogError} {catalog ? "Showing the last loaded catalog." : "The catalog is unavailable."} Your selections are kept.</ErrorNote></div> : null}
      {catalog?.errors.length ? <div role="alert"><ErrorNote>Some catalog entries could not be loaded. {catalog.errors.join(" ")} Unavailable selections are kept.</ErrorNote></div> : null}
      {readError ? <div role="alert"><ErrorNote>Could not read the latest saved selection. {readError} Showing the last known selection.</ErrorNote></div> : null}
      <fieldset disabled={saving || readingSaved} aria-busy={saving || readingSaved} className="min-w-0 space-y-5 disabled:opacity-70">
        <AbilityGroup
          title="Skills"
          items={(catalog?.skills ?? []).map((skill) => ({ ...skill, available: true, detail: skill.location ?? skill.capability ?? skill.id }))}
          selection={draft.skills}
          onChange={(update) => change("skills", update)}
          {...listProps}
        />
        <p className="text-[11px] leading-relaxed text-mist">Selected Cloud skills may still load their instructions through OpenWork Connect when it is not selected as a general MCP server.</p>
        <AbilityGroup
          title="MCP servers"
          items={(catalog?.mcpServers ?? []).map((server) => ({ ...server, detail: server.id }))}
          selection={draft.mcpServers}
          onChange={(update) => change("mcpServers", update)}
          {...listProps}
        />
      </fieldset>
      {stale ? <p className="text-xs leading-relaxed text-amber" role="status">Abilities changed elsewhere. Your displayed selection is kept; use the latest saved selection before saving.</p> : null}
      {saveError ? <div role="alert"><ErrorNote>Save not confirmed. {saveError} Your draft is kept. Reopen the editor to check the saved selection before trying again.</ErrorNote></div> : null}
      <div className="space-y-2 border-t border-line pt-3">
        <p className="text-[11px] text-mist" role="status">{readingSaved ? "Reading saved selection…" : saving ? "Saving abilities…" : saved && !stale ? `Abilities saved for ${coworker.name}.` : dirty ? "Unsaved changes. Save before leaving this editor." : "No unsaved changes."}</p>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {dirty || stale ? <Button type="button" variant="ghost" className="text-xs" disabled={saving || readingSaved} onClick={discard}>{stale ? "Use latest saved selection" : "Discard edits"}</Button> : null}
          <Button type="button" variant="primary" disabled={saving || readingSaved || !dirty || stale} aria-busy={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save changes"}</Button>
        </div>
      </div>
    </div>
  );
}

function AbilityGroup({ title, items, selection, onChange, loading, loaded, incomplete }: {
  title: string;
  items: AbilityOption[];
  selection: AbilitySelection;
  onChange: (update: (selection: AbilitySelection) => AbilitySelection) => void;
  loading: boolean;
  loaded: boolean;
  incomplete: boolean;
}) {
  const modeId = useId();
  const [search, setSearch] = useState("");
  const ids = new Set(items.map((item) => item.id));
  const missing = selection.ids.filter((id) => !ids.has(id)).map((id): AbilityOption => ({
    id,
    name: id,
    description: loading && !loaded ? "Waiting for the catalog. Your selection is kept." : "Not in the current catalog. Kept until you remove it.",
    source: "",
    detail: "",
    available: false,
  }));
  const query = search.trim().toLowerCase();
  const visible = [...items, ...missing].filter((item) => [item.id, item.name, item.description, item.source, item.detail].some((text) => text.toLowerCase().includes(query)));

  return (
    <section aria-label={title} className="min-w-0 space-y-2 border-t border-line/60 pt-2">
      <GroupLabel>{title}</GroupLabel>
      <div role="radiogroup" aria-label={`${title} selection`} className="flex flex-wrap gap-x-4 gap-y-2 px-1 text-xs text-snow">
        <label className="flex items-center gap-2">
          <input type="radio" name={modeId} value="all" className="accent-spark" checked={selection.mode === "all"} onChange={() => onChange((current) => ({ ...current, mode: "all" }))} />
          All available
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name={modeId} value="selected" className="accent-spark" checked={selection.mode === "selected"} onChange={() => onChange((current) => ({ ...current, mode: "selected" }))} />
          Selected only
        </label>
      </div>
      <p className="px-1 text-[11px] leading-relaxed text-mist">{selection.mode === "all" ? "Includes everything available. Switch to Selected only to edit the list; your picks are kept." : selection.ids.length === 0 ? "None selected." : `${selection.ids.length} selected. Unavailable entries are kept until you remove them.`}</p>
      <input type="search" aria-label={`Search ${title.toLowerCase()}`} placeholder={`Search ${title.toLowerCase()}`} className={inputClass} value={search} onChange={(event) => setSearch(event.target.value)} />
      {visible.length === 0 ? <QuietLine>{query ? "No matches." : loading && !loaded ? "Reading catalog…" : !loaded || incomplete ? "No catalog entries loaded. Your selections are kept." : `No ${title.toLowerCase()} in this catalog.`}</QuietLine> : (
        <ul aria-label={`${title} choices`} className="max-h-64 divide-y divide-line/60 overflow-y-auto overscroll-contain">
          {visible.map((item) => (
            <li key={item.id}>
              <label className="flex items-start gap-2 px-1 py-2 text-xs">
                <input
                  type="checkbox"
                  value={item.id}
                  className="mt-0.5 size-3.5 shrink-0 accent-spark"
                  checked={abilitySelected(selection, item.id)}
                  disabled={selection.mode === "all"}
                  onChange={() => onChange((current) => ({ ...current, ids: current.ids.includes(item.id) ? current.ids.filter((id) => id !== item.id) : [...current.ids, item.id] }))}
                />
                <span className="min-w-0 flex-1 space-y-1 [overflow-wrap:anywhere]">
                  <span className="block font-medium text-snow">{item.name}</span>
                  {!item.available ? <span className="block text-[11px] text-amber">{loading && !loaded ? "Checking availability…" : "Unavailable"}</span> : null}
                  {item.source ? <span className="block text-[11px] text-mist">{item.source}</span> : null}
                  {item.gateway ? <span className="block leading-relaxed text-mist">OpenWork Connect is one shared MCP gateway; selecting it includes its connected apps and generic tools. Per-connection Cloud authorization is unchanged.</span> : item.description ? <span className="block leading-relaxed text-mist">{item.description}</span> : null}
                  {item.detail ? <span className="block text-[10px] text-mist">{item.detail}</span> : null}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
