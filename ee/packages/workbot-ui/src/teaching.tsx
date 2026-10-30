"use client";

import { Button } from "@base-ui/react/button";
import { Select } from "@base-ui/react/select";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { browserInputLabel, browserSkillInputs, browserSkillRunPrompt, compileBrowserDemonstration, demonstrationStepLabel, demonstrationReplySchema, type BrowserDemonstration, type BrowserTeachingContext, type DemonstrationCommand, type DemonstrationStep } from "@openwork/types/browser-demonstration";
import { skillCreatedPayloadSchema, type SkillCreatedPayload } from "@openwork/types/skill-created-app";
import { errorMessage, workbotHost, useRetainedSurface } from "./host";

const button = "inline-flex h-8 items-center justify-center rounded-lg px-3 text-[13px] font-medium text-[var(--wb-text)] hover:bg-[var(--wb-chip)] disabled:opacity-50 focus-visible:shadow-[var(--wb-focus)]";
const input = "w-full rounded-lg border border-[var(--wb-hairline)] bg-[var(--wb-surface)] px-3 py-2 text-[13px] text-[var(--wb-text)] focus-visible:shadow-[var(--wb-focus)]";
const saveSchema = z.object({ saved: skillCreatedPayloadSchema, markdown: z.string() });
const identifier = (label: string) => label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** The Browser view's tab strip, when the page stream draws one: its tabs in their places, and the one on screen. */
export type TeachingLiveTabs = { frontId: string; tabs: Array<{ id: string; label: string }> };

/**
 * The same production panel is used beside the live browser and in its UI journey. With `liveTabs`, tabs are named and
 * ordered as in the tab strip, teaching starts on the tab on screen unless another is chosen, and `onShowTab` brings
 * the taught tab back to the front.
 */
export function WorkbotTeaching({ onTakeControl, onTeachingChange, onRun, suspended = false, liveTabs, onShowTab }: { suspended?: boolean; onTakeControl(): void; onTeachingChange?(context: BrowserTeachingContext | undefined): void; onRun?(text: string): void | Promise<void>; liveTabs?: TeachingLiveTabs; onShowTab?(id: string): void }) {
  const host = workbotHost();
  const [demo, setDemo] = useState<BrowserDemonstration | null>(null);
  const [listed, setTabs] = useState<Array<{ id: string; origin: string }>>([]);
  // Empty: the tab on screen, or the browser's most recent one.
  const [chosen, setTab] = useState("");
  const [tabPickerOpen, setTabPickerOpen] = useState(false);
  const tabSurface = useRetainedSurface(tabPickerOpen && !suspended && host.browserDemonstrations === true);
  const [opened, setOpened] = useState(false);
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
      if (reply.demonstration) setOpened(true);
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
  useEffect(() => {
    if ((!opened && !demo) || !host.browserDemonstrations || host.documentAuthorization || suspended) return;
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
  }, [opened, host, accept, demo?.id, suspended]);
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
  const enabled = host.browserDemonstrations === true && !host.documentAuthorization && !suspended;
  const conflict = selected && (selected.revision ?? 0) !== editingRevision;
  const variableName = identifier(variable);
  const needsVariable = selected?.parameter || selected?.field;
  return <section aria-label="Teach Workbot" className="flex min-h-0 w-full flex-col border-b border-[var(--wb-hairline)] bg-[var(--wb-bg)] text-[var(--wb-text)]" data-testid="workbot-teaching">
    <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
      <Button className={button} disabled={!enabled || busy} onClick={() => { setOpened(current => !current); if (!opened) void command({ action: "tabs" }); }} aria-expanded={opened}>{suspended ? "Teaching paused · Resume the computer" : "Teach Workbot"}</Button>
      {(opened || demo) && <span role="status" className="text-[12px] text-[var(--wb-muted)]">{saved ? "Saved · No run verified" : demo ? `${demo.phase === "recording" ? "Recording" : demo.phase === "paused" ? "Paused" : "Reviewing"} · ${demo.steps.length} steps` : "No demonstration"}</span>}
    </div>
    {opened && <div className="flex max-h-[55vh] flex-col gap-3 overflow-y-auto px-4 pb-4">
      {error && <p role="alert" className="text-[13px]">{error}</p>}
      {syncError && <p role="status" className="text-[13px]">{syncError}</p>}
      {demo?.notice && <p role="status" className="text-[13px]">{demo.notice}</p>}
      {taughtTab && taughtTab.id !== liveTabs?.frontId && <p role="status" className="flex flex-wrap items-center gap-2 text-[13px]">Only “{taughtTab.label}” is recorded, not the tab on screen.{onShowTab && <Button className={button} onClick={() => onShowTab(taughtTab.id)}>Show taught tab</Button>}</p>}
      {!demo ? <>
        <div className="text-[13px]">
          <span>Browser tab</span>
          <Select.Root items={tabs.map((item, index) => ({ value: item.id, label: tabLabel(item, index) }))} value={tab || null} onValueChange={value => setTab(value ?? "")} disabled={busy || !enabled} open={tabSurface.open} onOpenChange={value => { if (!tabSurface.blocked) setTabPickerOpen(value); }}>
            <Select.Trigger aria-label="Tab to teach" className={`${input} text-left`}><Select.Value placeholder="Choose a browser tab" /></Select.Trigger>
            <Select.Portal {...tabSurface.portal}>
              <Select.Positioner sideOffset={4} collisionPadding={8} alignItemWithTrigger={false} className="z-50">
                <Select.Popup className="workbot w-[var(--anchor-width)] max-w-[var(--available-width)] rounded-lg bg-[var(--wb-surface)] p-1 text-[var(--wb-text)] shadow-[var(--wb-panel-shadow)]">
                  <Select.List className="max-h-[var(--available-height)] overflow-y-auto">{tabs.map((item, index) => <Select.Item key={item.id} value={item.id} className={`${button} w-full justify-start data-[highlighted]:bg-[var(--wb-chip)]`}><Select.ItemText>{tabLabel(item, index)}</Select.ItemText></Select.Item>)}</Select.List>
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
        </div>
        <div className="flex gap-2"><Button className={`${button} bg-[var(--wb-chip)]`} disabled={!enabled || busy || !tab} onClick={() => void command({ action: "start", tabId: tab })}>Start teaching</Button><Button className={button} disabled={!enabled || busy} onClick={() => void command({ action: "tabs" })}>Refresh tabs</Button></div>
        <details className="text-[12px] text-[var(--wb-muted)]"><summary className="cursor-pointer">What is saved</summary><p className="pt-2">Steps and your explanations become a private skill after you review it. Entered values and navigation addresses are omitted. You provide a public starting page when running it.</p></details>
      </> : <>
        {demo.phase !== "draft" && <div className="flex flex-wrap gap-1">
          <Button className={button} disabled={!enabled || busy} onClick={() => void command({ action: demo.phase === "recording" ? "pause" : "resume" })}>{demo.phase === "recording" ? "Pause recording" : "Resume recording"}</Button>
          <Button className={button} disabled={!enabled || busy || demo.phase !== "recording"} onClick={() => void command({ action: "pick" })}>Select information</Button>
          <Button className={button} disabled={!enabled || busy || !demo.steps.length} onClick={() => void command({ action: "finish" })}>Finish teaching</Button>
        </div>}
        {!saved && <div className="flex items-center justify-between gap-2 text-[13px]"><span>{selected ? `Explaining step ${selected.id}` : "Explaining the latest step"}: {focusedLabel}</span>{selected && <Button className={button} onClick={() => setStepId(null)}>Use latest step</Button>}</div>}
        <details key={demo.phase === "draft" ? "review" : "record"} open={demo.phase === "draft"}>
          <summary className="cursor-pointer text-[13px]">Recorded steps ({demo.steps.length})</summary>
          <ol className="mt-2 space-y-1" aria-label="Demonstrated steps">{demo.steps.map(step => <li key={step.id}><Button className={`${button} h-auto min-h-8 w-full justify-start text-left ${stepId === step.id ? "bg-[var(--wb-chip)]" : ""}`} aria-pressed={stepId === step.id} onClick={() => chooseStep(step)}>{step.id}. {demonstrationStepLabel(step)}</Button></li>)}</ol>
        </details>
        {selected && !saved && <div className="flex flex-col gap-2">
          {conflict && <p role="status" className="text-[13px]">This step has newer chat notes. <Button className={button} onClick={() => chooseStep(selected)}>Use current explanation</Button></p>}
          <label className="text-[13px]">Explain step {selected.id}<textarea className={input} value={explanation} maxLength={2000} onChange={event => setExplanation(event.target.value)} /></label>
          {needsVariable && <label className="text-[13px]">{selected.parameter ? "Input name" : "Output field"}<input className={input} value={variable} maxLength={64} onChange={event => setVariable(event.target.value)} /></label>}
          <Button className={button} disabled={!enabled || busy || conflict || Boolean(needsVariable && !/^[a-z][a-z0-9_]{0,63}$/.test(variableName))} onClick={() => { void command({ action: "edit", stepId: selected.id, explanation, expectedRevision: editingRevision, ...(selected.parameter ? { parameter: variableName } : selected.field ? { field: variableName } : {}) }).then(reply => { const current = reply?.demonstration?.steps.find(step => step.id === selected.id); if (current) chooseStep(current); }); }}>Save step</Button>
        </div>}
        {demo.phase === "draft" && !saved && <>
          <label className="text-[13px]">Skill name<input className={input} value={name} maxLength={100} onChange={event => setName(event.target.value)} /></label>
          <label className="text-[13px]">When to use this skill<textarea className={input} value={purpose} maxLength={1000} onChange={event => setPurpose(event.target.value)} /></label>
          {previewError && <p role="alert" className="text-[13px]">{previewError}</p>}
          {preview && <details><summary className="cursor-pointer text-[13px]">Skill instructions</summary><pre className="mt-2 whitespace-pre-wrap break-words text-[12px]">{preview}</pre></details>}
          <Button className={`${button} bg-[var(--wb-chip)]`} disabled={!enabled || busy || !preview} onClick={() => void save()}>Save private skill</Button>
        </>}
        {saved && <>
          <p role="status" className="text-[13px]">Saved “{saved.name}” to your private skills.</p>
          {saved.libraryUrl && /^https?:\/\//.test(saved.libraryUrl) && <a className="text-[13px] underline" href={saved.libraryUrl} target="_blank" rel="noopener noreferrer">Open saved skill</a>}
          <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); void run(); }}>
            {browserSkillInputs(demo).map(item => <label key={item.name} className="text-[13px]">{item.label}<input className={input} type={item.kind === "url" ? "url" : "text"} value={Object.hasOwn(runValues, item.name) ? runValues[item.name] ?? "" : ""} maxLength={2000} disabled={busy} onChange={event => setRunValues(current => ({ ...current, [item.name]: event.target.value }))} placeholder={item.kind === "url" ? "https://…" : "Ask me in chat"} /></label>)}
            <Button type="submit" className={`${button} bg-[var(--wb-chip)]`} disabled={!enabled || !onRun || busy}>Run skill</Button>
          </form>
        </>}
        <Button className={button} disabled={!enabled || busy} onClick={() => void command({ action: "discard" })}>{saved ? "Teach another task" : "Discard demonstration"}</Button>
      </>}
    </div>}
  </section>;
}
