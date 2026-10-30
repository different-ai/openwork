"use client";

import { Button } from "@base-ui/react/button";
import { Select } from "@base-ui/react/select";
import { ChevronDown, Pause, Play, Presentation, RotateCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { browserInputLabel, browserSkillInputs, browserSkillRunPrompt, compileBrowserDemonstration, demonstrationStepLabel, demonstrationReplySchema, type BrowserDemonstration, type BrowserTeachingContext, type DemonstrationCommand, type DemonstrationStep } from "@openwork/types/browser-demonstration";
import { skillCreatedPayloadSchema, type SkillCreatedPayload } from "@openwork/types/skill-created-app";
import { errorMessage, workbotHost, useRetainedSurface } from "./host";

const button = "inline-flex h-8 items-center justify-center rounded-lg px-3 text-[13px] font-medium text-[var(--wb-text)] hover:bg-[var(--wb-chip)] disabled:opacity-50 focus-visible:shadow-[var(--wb-focus)]";
const primary = "inline-flex h-8 items-center justify-center rounded-lg bg-[var(--wb-ink)] px-3 text-[13px] font-medium text-[var(--wb-on-ink)] hover:opacity-90 disabled:opacity-50 focus-visible:shadow-[var(--wb-focus)]";
const iconButton = "relative grid size-8 shrink-0 place-items-center rounded-full text-[var(--wb-muted)] transition-colors duration-150 hover:bg-[var(--wb-chip)] hover:text-[var(--wb-text)] disabled:opacity-50 aria-pressed:bg-[var(--wb-chip)] aria-pressed:text-[var(--wb-text)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]";
const input = "w-full rounded-lg border border-[var(--wb-hairline)] bg-[var(--wb-surface)] px-3 py-2 text-[13px] text-[var(--wb-text)] focus-visible:shadow-[var(--wb-focus)]";
const saveSchema = z.object({ saved: skillCreatedPayloadSchema, markdown: z.string() });
const identifier = (label: string) => label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** The Browser view's tab strip, when the page stream draws one: its tabs in their places, and the one on screen. */
export type TeachingLiveTabs = { frontId: string; tabs: Array<{ id: string; label: string }> };

/**
 * The Browser view's quiet toolbar control for teaching: a whiteboard that opens the teaching window, with a dot while
 * a demonstration records.
 */
export function TeachButton({ open, recording, suspended = false, onClick }: { open: boolean; recording: boolean; suspended?: boolean; onClick(): void }) {
  const label = suspended ? "Resume the computer to teach Workbot" : recording ? "Teach Workbot, recording" : "Teach Workbot";
  return <Button className={iconButton} aria-label="Teach Workbot" title={label} aria-pressed={open} disabled={suspended && !open} onClick={onClick}>
    <Presentation size={16} strokeWidth={1.5} aria-hidden />
    {recording ? <span aria-hidden className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-[var(--wb-danger)] ring-2 ring-[var(--wb-bg)]" /> : null}
  </Button>;
}

/**
 * The teaching window, floating over the browser so the page keeps its space. The same production window is used beside
 * the live browser and in its UI journey; it stays mounted while closed, so a demonstration and its review fields
 * survive closing it or switching views. With `liveTabs`, tabs are named and ordered as in the tab strip, teaching
 * starts on the tab on screen unless another is chosen, and `onShowTab` brings the taught tab back to the front.
 */
export function WorkbotTeaching({ open, onOpenChange, onTakeControl, onTeachingChange, onRun, suspended = false, liveTabs, onShowTab }: { open: boolean; onOpenChange(open: boolean): void; suspended?: boolean; onTakeControl(): void; onTeachingChange?(context: BrowserTeachingContext | undefined): void; onRun?(text: string): void | Promise<void>; liveTabs?: TeachingLiveTabs; onShowTab?(id: string): void }) {
  const host = workbotHost();
  const [demo, setDemo] = useState<BrowserDemonstration | null>(null);
  const [listed, setTabs] = useState<Array<{ id: string; origin: string }>>([]);
  // Empty: the tab on screen, or the browser's most recent one.
  const [chosen, setTab] = useState("");
  const [tabPickerOpen, setTabPickerOpen] = useState(false);
  const tabSurface = useRetainedSurface(tabPickerOpen && !suspended && host.browserDemonstrations === true);
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [saved, setSaved] = useState<SkillCreatedPayload | null>(null);
  const [runValues, setRunValues] = useState<Record<string, string>>({});
  const [stepId, setStepId] = useState<number | null>(null);
  const [explanation, setExplanation] = useState("");
  const [variable, setVariable] = useState("");
  const [editingRevision, setEditingRevision] = useState(0);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const changes = useRef(0);
  const body = useRef<HTMLDivElement>(null);
  const openChange = useRef(onOpenChange);
  openChange.current = onOpenChange;
  const selected = demo?.steps.find(step => step.id === stepId);
  const focused = selected ?? demo?.steps.at(-1);
  const focusedLabel = focused ? demonstrationStepLabel(focused) : "Task instructions";
  // The browser lists tabs most recently used first; the strip keeps them where they opened.
  const strip = new Map(liveTabs?.tabs.map((item, index) => [item.id, { label: item.label, place: index }]));
  const tabs = liveTabs ? [...listed].sort((a, b) => (strip.get(a.id)?.place ?? Infinity) - (strip.get(b.id)?.place ?? Infinity)) : listed;
  const tabLabel = (item: { id: string; origin: string }, index: number) => {
    const shown = strip.get(item.id)?.label ?? `${item.origin === "null" ? "Blank page" : item.origin} · Tab ${index + 1}`;
    return item.id === liveTabs?.frontId ? `${shown} (on screen)` : shown;
  };
  const tab = chosen || (liveTabs && listed.some(item => item.id === liveTabs.frontId) ? liveTabs.frontId : listed[0]?.id ?? "");
  const taughtTab = demo && demo.phase !== "draft" && liveTabs ? liveTabs.tabs.find(item => item.id === demo.tabId) : undefined;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; onTeachingChange?.(undefined); }; }, [onTeachingChange]);
  useEffect(() => {
    onTeachingChange?.(demo && !saved && host.browserDemonstrations ? { id: demo.id, phase: demo.phase, ...(selected ? { stepId: selected.id } : {}), label: selected ? `Step ${selected.id}: ${focusedLabel}` : `Latest step: ${focusedLabel}` } : undefined);
  }, [demo?.id, demo?.phase, selected?.id, focusedLabel, saved, host.browserDemonstrations, onTeachingChange]);
  const accept = useCallback((payload: unknown) => {
    const reply = demonstrationReplySchema.parse(payload);
    setDemo(reply.demonstration);
    if (reply.tabs) { setTabs(reply.tabs); setTab(current => reply.tabs?.some(tab => tab.id === current) ? current : ""); }
    return reply;
  }, []);
  useEffect(() => {
    if (!host.browserDemonstrations || host.documentAuthorization || suspended) return;
    const controller = new AbortController();
    const revision = changes.current;
    void host.requestJson("/v1/workbot/teaching", { method: "POST", body: JSON.stringify({ action: "read" }), signal: controller.signal }, 30_000).then(({ response, payload }) => {
      if (!mounted.current || controller.signal.aborted || revision !== changes.current || !response.ok) return;
      const reply = accept(payload);
      // A demonstration already under way opens its window again.
      if (reply.demonstration) openChange.current(true);
    }).catch(() => { /* Opening an older desktop keeps the explicit Teach control available. */ });
    return () => controller.abort();
  }, [host, accept, suspended]);
  const chooseStep = (step: DemonstrationStep) => {
    setStepId(step.id); setExplanation(step.explanation); setEditingRevision(step.revision ?? 0);
    const key = step.parameter ?? step.field ?? "";
    setVariable(/^(input|field)_\d+$/.test(key) ? step.target?.name || browserInputLabel(key) : browserInputLabel(key));
  };
  const command = async (body: DemonstrationCommand) => {
    if (inFlight.current) return;
    inFlight.current = true; changes.current++; setBusy(true); setError(null);
    try {
      const { response, payload } = await host.requestJson("/v1/workbot/teaching", { method: "POST", body: JSON.stringify(body) }, 195_000);
      if (!response.ok) throw new Error(errorMessage(payload, "Couldn't update the demonstration. Reconnect to check its state."));
      if (!mounted.current) return;
      const reply = accept(payload);
      if (body.action === "start" || body.action === "resume") onTakeControl();
      if (body.action === "discard") { setSaved(null); setStepId(null); setName(""); setPurpose(""); setRunValues({}); }
      return reply;
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : "Teaching is unavailable."); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  };
  const enabled = host.browserDemonstrations === true && !host.documentAuthorization && !suspended;
  // Opening the window shows it whole; with nothing being taught, it lists the tabs to choose from.
  useEffect(() => {
    if (!open) return;
    setCollapsed(false);
    if (!demo && enabled) void command({ action: "tabs" });
  }, [open]);
  useEffect(() => {
    if ((!open && !demo) || !host.browserDemonstrations || host.documentAuthorization || suspended) return;
    let disposed = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!inFlight.current) {
        const revision = changes.current;
        try {
          const { response, payload } = await host.requestJson("/v1/workbot/teaching", { method: "POST", body: JSON.stringify({ action: "read" }), signal: controller.signal }, 30_000);
          if (!disposed && revision === changes.current && response.ok) { accept(payload); setSyncError(null); }
          else if (!disposed && revision === changes.current) setSyncError(errorMessage(payload, "Teaching access couldn't be verified. Recording will pause."));
        } catch { if (!disposed) setSyncError("Teaching disconnected. Recording will pause; reconnect before continuing."); }
      }
      if (!disposed) timer = setTimeout(() => void poll(), 3000);
    };
    timer = setTimeout(() => void poll(), 3000);
    return () => { disposed = true; controller.abort(); clearTimeout(timer); };
  }, [open, host, accept, demo?.id, suspended]);
  // While recording, keep the newest step in view as it arrives.
  useEffect(() => {
    const container = body.current, row = container?.querySelector<HTMLElement>("[data-latest-step]");
    if (!container || !row || demo?.phase !== "recording" || stepId !== null) return;
    const bottom = row.offsetTop + row.offsetHeight - container.clientHeight + 12;
    if (container.scrollTop < bottom) container.scrollTop = bottom;
  }, [demo?.steps.length, demo?.phase, stepId, collapsed]);
  const save = async () => {
    if (!demo || inFlight.current) return;
    inFlight.current = true; changes.current++; setBusy(true); setError(null);
    try {
      const { response, payload } = await host.requestJson("/v1/workbot/teaching", { method: "POST", body: JSON.stringify({ action: "save", demonstrationId: demo.id, name, purpose }) }, 60_000);
      if (!response.ok) throw new Error(errorMessage(payload, "Couldn't confirm the save. Check your skill library before trying again."));
      if (mounted.current) setSaved(saveSchema.parse(payload).saved);
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : "Couldn't confirm the save."); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  };
  const run = async () => {
    if (!demo || !saved || !onRun || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    try { await onRun(browserSkillRunPrompt(saved.name, demo, runValues)); }
    catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : "Couldn't start the run. Your inputs are still here."); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  };
  let preview = "", previewError = "";
  if (demo?.phase === "draft" && name.trim() && purpose.trim()) {
    try { preview = compileBrowserDemonstration(demo, name, purpose); }
    catch (error) { previewError = error instanceof Error ? error.message : "Review the recorded steps before saving."; }
  }
  const conflict = selected && (selected.revision ?? 0) !== editingRevision;
  const variableName = identifier(variable);
  const needsVariable = selected?.parameter || selected?.field;
  const status = saved ? "Saved" : demo ? ({ recording: "Recording", paused: "Paused", draft: "Reviewing" } as const)[demo.phase] : suspended ? "Computer paused" : null;
  if (!open) return null;
  return <section aria-label="Teach Workbot" data-testid="workbot-teaching" className="workbot-fade-in flex max-h-full w-[min(22rem,100%)] flex-col overflow-hidden rounded-xl bg-[var(--wb-surface)] text-[var(--wb-text)] shadow-[var(--wb-panel-shadow)]">
    <div className="flex h-11 shrink-0 items-center gap-2 pl-3 pr-1.5">
      <Presentation size={16} strokeWidth={1.5} aria-hidden className="shrink-0 text-[var(--wb-muted)]" />
      <h2 className="min-w-0 truncate text-[13px] font-semibold">Teach Workbot</h2>
      <span role="status" className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-[12px] text-[var(--wb-muted)]">
        {demo?.phase === "recording" && !saved ? <span aria-hidden className="size-1.5 rounded-full bg-[var(--wb-danger)]" /> : null}{status}
      </span>
      <Button className={iconButton} aria-label={collapsed ? "Expand teaching" : "Collapse teaching"} title={collapsed ? "Expand" : "Collapse"} aria-expanded={!collapsed} onClick={() => setCollapsed(current => !current)}>
        <ChevronDown size={16} strokeWidth={1.5} aria-hidden className={`transition-transform duration-150 ease-out motion-reduce:transition-none ${collapsed ? "-rotate-90" : ""}`} />
      </Button>
      <Button className={iconButton} aria-label="Hide teaching" title={demo && demo.phase !== "draft" ? "Hide (teaching continues)" : "Hide"} onClick={() => onOpenChange(false)}><X size={16} strokeWidth={1.5} aria-hidden /></Button>
    </div>
    {collapsed ? demo && !saved ? <p className="truncate px-3 pb-3 text-[12px] text-[var(--wb-muted)]">{selected ? `Step ${selected.id}` : "Latest step"}: {focusedLabel}</p> : null
    : <div ref={body} className="relative flex min-h-0 flex-col gap-3 overflow-y-auto border-t border-[var(--wb-hairline)] p-3">
      {error && <p role="alert" className="text-[13px]">{error}</p>}
      {syncError && <p role="status" className="text-[13px]">{syncError}</p>}
      {demo?.notice && <p role="status" className="text-[13px]">{demo.notice}</p>}
      {taughtTab && taughtTab.id !== liveTabs?.frontId && <p role="status" className="flex flex-wrap items-center gap-2 text-[13px]">Only “{taughtTab.label}” is recorded, not the tab on screen.{onShowTab && <Button className={button} onClick={() => onShowTab(taughtTab.id)}>Show taught tab</Button>}</p>}
      {!demo ? <>
        <div className="flex flex-col gap-1.5 text-[13px]">
          <span className="font-medium">Browser tab</span>
          <Select.Root items={tabs.map((item, index) => ({ value: item.id, label: tabLabel(item, index) }))} value={tab || null} onValueChange={value => setTab(value ?? "")} disabled={busy || !enabled} open={tabSurface.open} onOpenChange={value => { if (!tabSurface.blocked) setTabPickerOpen(value); }}>
            <Select.Trigger aria-label="Tab to teach" className={`${input} truncate text-left`}><Select.Value placeholder="Choose a browser tab" /></Select.Trigger>
            <Select.Portal {...tabSurface.portal}>
              <Select.Positioner sideOffset={4} collisionPadding={8} alignItemWithTrigger={false} className="z-50">
                <Select.Popup className="workbot w-[var(--anchor-width)] max-w-[var(--available-width)] rounded-lg bg-[var(--wb-surface)] p-1 text-[var(--wb-text)] shadow-[var(--wb-panel-shadow)]">
                  <Select.List className="max-h-[var(--available-height)] overflow-y-auto">{tabs.map((item, index) => <Select.Item key={item.id} value={item.id} className={`${button} w-full justify-start data-[highlighted]:bg-[var(--wb-chip)]`}><Select.ItemText className="truncate">{tabLabel(item, index)}</Select.ItemText></Select.Item>)}</Select.List>
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
        </div>
        <div className="flex items-center gap-1">
          <Button className={`${primary} flex-1`} disabled={!enabled || busy || !tab} onClick={() => void command({ action: "start", tabId: tab })}>Start teaching</Button>
          <Button className={iconButton} aria-label="Refresh tabs" title="Refresh tabs" disabled={!enabled || busy} onClick={() => void command({ action: "tabs" })}><RotateCw size={16} strokeWidth={1.5} aria-hidden /></Button>
        </div>
        <details className="text-[12px] text-[var(--wb-muted)]"><summary className="cursor-pointer">What is saved</summary><p className="pt-2">Steps and your explanations become a private skill after you review it. Entered values and navigation addresses are omitted. You provide a public starting page when running it.</p></details>
      </> : <>
        {demo.phase !== "draft" && <div className="flex items-center gap-1">
          <Button className={iconButton} aria-label={demo.phase === "recording" ? "Pause recording" : "Resume recording"} title={demo.phase === "recording" ? "Pause recording" : "Resume recording"} disabled={!enabled || busy} onClick={() => void command({ action: demo.phase === "recording" ? "pause" : "resume" })}>{demo.phase === "recording" ? <Pause size={16} strokeWidth={1.5} aria-hidden /> : <Play size={16} strokeWidth={1.5} aria-hidden />}</Button>
          <Button className={button} disabled={!enabled || busy || demo.phase !== "recording"} onClick={() => void command({ action: "pick" })}>Select information</Button>
          <Button className={`${primary} ml-auto`} disabled={!enabled || busy || !demo.steps.length} onClick={() => void command({ action: "finish" })}>Finish teaching</Button>
        </div>}
        <div className="flex flex-col gap-1">
          <h3 className="text-[12px] font-medium text-[var(--wb-muted)]">Recorded steps ({demo.steps.length})</h3>
          {demo.steps.length ? <ol className="flex flex-col" aria-label="Demonstrated steps">{demo.steps.map((step, index) => <li key={step.id} {...(index === demo.steps.length - 1 ? { "data-latest-step": "" } : {})}>
            <Button className={`${button} h-auto min-h-8 w-full justify-start gap-2 py-1.5 text-left font-normal ${stepId === step.id ? "bg-[var(--wb-chip)]" : ""}`} aria-pressed={stepId === step.id} onClick={() => chooseStep(step)}>
              <span className="w-5 shrink-0 text-right tabular-nums text-[var(--wb-muted)]">{step.id}.</span>
              <span className="min-w-0 flex-1">{demonstrationStepLabel(step)}{step.explanation ? <span className="block truncate text-[12px] text-[var(--wb-muted)]">{step.explanation.split("\n").at(-1)}</span> : null}</span>
            </Button>
          </li>)}</ol> : <p className="text-[13px] text-[var(--wb-muted)]">No steps yet. What you do on the page appears here.</p>}
        </div>
        {!saved && <div className="flex items-center justify-between gap-2 text-[13px]"><span className="min-w-0">{selected ? `Explaining step ${selected.id}` : "Explaining the latest step"}: {focusedLabel}</span>{selected && <Button className={`${button} shrink-0`} onClick={() => setStepId(null)}>Use latest step</Button>}</div>}
        {selected && !saved && <div className="flex flex-col gap-2">
          {conflict && <p role="status" className="text-[13px]">This step has newer chat notes. <Button className={button} onClick={() => chooseStep(selected)}>Use current explanation</Button></p>}
          <label className="flex flex-col gap-1.5 text-[13px]">Explain step {selected.id}<textarea className={input} value={explanation} maxLength={2000} onChange={event => setExplanation(event.target.value)} /></label>
          {needsVariable && <label className="flex flex-col gap-1.5 text-[13px]">{selected.parameter ? "Input name" : "Output field"}<input className={input} value={variable} maxLength={64} onChange={event => setVariable(event.target.value)} /></label>}
          <Button className={`${button} self-start bg-[var(--wb-chip)]`} disabled={!enabled || busy || conflict || Boolean(needsVariable && !/^[a-z][a-z0-9_]{0,63}$/.test(variableName))} onClick={() => { void command({ action: "edit", stepId: selected.id, explanation, expectedRevision: editingRevision, ...(selected.parameter ? { parameter: variableName } : selected.field ? { field: variableName } : {}) }).then(reply => { const current = reply?.demonstration?.steps.find(step => step.id === selected.id); if (current) chooseStep(current); }); }}>Save step</Button>
        </div>}
        {demo.phase === "draft" && !saved && <>
          <label className="flex flex-col gap-1.5 text-[13px]">Skill name<input className={input} value={name} maxLength={100} onChange={event => setName(event.target.value)} /></label>
          <label className="flex flex-col gap-1.5 text-[13px]">When to use this skill<textarea className={input} value={purpose} maxLength={1000} onChange={event => setPurpose(event.target.value)} /></label>
          {previewError && <p role="alert" className="text-[13px]">{previewError}</p>}
          {preview && <details><summary className="cursor-pointer text-[13px]">Skill instructions</summary><pre className="mt-2 whitespace-pre-wrap break-words text-[12px]">{preview}</pre></details>}
          <Button className={primary} disabled={!enabled || busy || !preview} onClick={() => void save()}>Save private skill</Button>
        </>}
        {saved && <>
          <p role="status" className="text-[13px]">Saved “{saved.name}” to your private skills. No run verified yet.</p>
          {saved.libraryUrl && /^https?:\/\//.test(saved.libraryUrl) && <a className="text-[13px] underline" href={saved.libraryUrl} target="_blank" rel="noopener noreferrer">Open saved skill</a>}
          <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); void run(); }}>
            {browserSkillInputs(demo).map(item => <label key={item.name} className="flex flex-col gap-1.5 text-[13px]">{item.label}<input className={input} type={item.kind === "url" ? "url" : "text"} value={Object.hasOwn(runValues, item.name) ? runValues[item.name] ?? "" : ""} maxLength={2000} disabled={busy} onChange={event => setRunValues(current => ({ ...current, [item.name]: event.target.value }))} placeholder={item.kind === "url" ? "https://…" : "Ask me in chat"} /></label>)}
            <Button type="submit" className={primary} disabled={!enabled || !onRun || busy}>Run skill</Button>
          </form>
        </>}
        <Button className={`${button} self-start text-[var(--wb-muted)]`} disabled={!enabled || busy} onClick={() => void command({ action: "discard" })}>{saved ? "Teach another task" : "Discard demonstration"}</Button>
      </>}
    </div>}
  </section>;
}
