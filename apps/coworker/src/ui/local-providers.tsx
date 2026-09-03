import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  coworkerBridge,
  type LocalProviderFinding,
  type LocalProvidersReadiness,
  type RuntimeInfo,
} from "@/lib/bridge";
import type { DenSession } from "@/lib/den";
import {
  IDLE,
  LOCAL_MODE_COPY as COPY,
  busyProviderIds,
  connectReducer,
  pickFreeModel,
  planLocalMode,
  type AddableProvider,
  type ConnectState,
  type ConnectedRow,
} from "@/lib/local-providers";
import { createCoworkerThreads, type EngineModelCatalog } from "@/lib/threads";
import { Button, ErrorNote, StatusDot, inputClass } from "@/ui/kit";
import { OptionRow } from "@/ui/interactions";
import { GroupLabel, QuietLine, TechnicalDetails } from "@/ui/rows";

const EMPTY_CATALOG: EngineModelCatalog = { models: [], connectedProviderIds: [], cloud: null };
const EMPTY_READINESS: LocalProvidersReadiness = { workspaceId: "", engineManaged: false, serverUrl: "", ownerToken: "", providers: [], signIns: {} };
const RECOMMENDED_DISMISSED_KEY = "coworker.local-mode.recommended-dismissed";
const SIGN_IN_POLL_MS = 2_000;

function readDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(RECOMMENDED_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    window.sessionStorage.setItem(RECOMMENDED_DISMISSED_KEY, "1");
  } catch {
    // Session storage is a convenience; the banner simply shows again next time.
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function SparkIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 fill-none stroke-current" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z" />
      <path d="M5 18.5l.7 1.8 1.8.7-1.8.7L5 23.5l-.7-1.8-1.8-.7 1.8-.7z" transform="translate(0 -2)" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 fill-none stroke-current" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l8.5-8.5M16 6.5l2.5 2.5M14 8.5l2.5 2.5" />
    </svg>
  );
}

function ServerIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 fill-none stroke-current" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4.5" width="16" height="6" rx="1.5" />
      <rect x="4" y="13.5" width="16" height="6" rx="1.5" />
      <path d="M7.5 7.5h.01M7.5 16.5h.01" />
    </svg>
  );
}

function GiftIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 fill-none stroke-current" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="9" width="16" height="11" rx="1.5" />
      <path d="M4 13h16M12 9v11M12 9c-2.5 0-4.5-1.3-4.5-3S9 3.5 10 4.2 12 9 12 9zm0 0c2.5 0 4.5-1.3 4.5-3S15 3.5 14 4.2 12 9 12 9z" />
    </svg>
  );
}

function PlusCircleIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 fill-none stroke-current" strokeWidth="1.7" strokeLinecap="round">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  );
}

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={`size-4 fill-none stroke-current ${spinning ? "animate-spin" : ""}`} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 12a8 8 0 1 1-2.3-5.6" />
      <path d="M20 4v4.5h-4.5" />
    </svg>
  );
}

function iconFor(kind: LocalProviderFinding["kind"]): ReactNode {
  if (kind === "server") return <ServerIcon />;
  if (kind === "env" || kind === "opencode") return <KeyIcon />;
  return <SparkIcon />;
}

/** One flat row: an icon, a title, one line beneath it, and whatever sits at the end. */
function FlatRow({ icon, title, line, tone, children, testId, extra }: { icon: ReactNode; title: string; line: string; tone?: "mint" | "amber" | "rose" | "mist"; children?: ReactNode; testId?: string; extra?: ReactNode }) {
  return (
    <li className="border-t border-line/70 py-3 first:border-t-0" data-testid={testId}>
      <div className="flex items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-panel text-mist" aria-hidden="true">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-snow">{title}</span>
          {line ? (
            <span className="mt-0.5 flex items-start gap-1.5 text-[11px] leading-snug text-mist">
              {tone ? <span className="mt-[5px] shrink-0"><StatusDot tone={tone} /></span> : null}
              <span className="line-clamp-2" data-testid={testId ? `${testId}-line` : undefined}>{line}</span>
            </span>
          ) : null}
        </span>
        {children ? <span className="flex shrink-0 items-center gap-2">{children}</span> : null}
      </div>
      {extra}
    </li>
  );
}

/** The sign-in card style row: the code when there is one, Open browser, I've finished, Cancel. */
function SignInWait({ state, onOpen, onCheck, onCancel }: { state: Extract<ConnectState, { phase: "waiting" }>; onOpen: () => void; onCheck: () => void; onCancel: () => void }) {
  return (
    <div className="mt-3 ml-11 overflow-hidden rounded-xl border border-line bg-ink/60" role="listbox" aria-label="Finish signing in" data-testid="sign-in-wait">
      {state.code ? (
        <p className="border-b border-line px-3 py-2.5 text-center font-mono text-lg tracking-[0.2em] text-snow" data-testid="sign-in-code">{state.code}</p>
      ) : null}
      <OptionRow letter="A" label={COPY.openBrowser} description={state.line} onChoose={onOpen} />
      <OptionRow letter="B" label={COPY.finished} onChoose={onCheck} />
      <OptionRow letter="C" label={COPY.cancel} tone="danger" onChoose={onCancel} />
    </div>
  );
}

function KeyForm({ provider, onSaved, onCancel }: { provider: AddableProvider; onSaved: (line: string, providerId: string) => void; onCancel: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    setBusy(true);
    setError("");
    try {
      const result = await coworkerBridge.localProviders.saveKey(provider.id, key);
      setKey("");
      onSaved(COPY.connectedLine(result.modelCount), provider.id);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="mt-3 ml-11 space-y-2"
      data-testid="key-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <input
        className={`${inputClass} font-mono text-xs`}
        type="password"
        autoComplete="off"
        spellCheck={false}
        aria-label={`${provider.label} key`}
        placeholder={COPY.keyPlaceholder}
        value={key}
        onChange={(event) => setKey(event.target.value)}
      />
      <p className="text-[11px] text-mist">{COPY.keyHint(provider.envName)}</p>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" disabled={busy || !key.trim()} aria-busy={busy}>{busy ? COPY.connecting : COPY.save}</Button>
        <Button type="button" variant="ghost" onClick={onCancel}>{COPY.cancel}</Button>
      </div>
    </form>
  );
}

function CustomForm({ onSaved, onCancel, onStartModel }: { onSaved: (line: string, providerId: string) => void; onCancel: () => void; onStartModel?: (modelId: string) => void }) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [key, setKey] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [startWith, setStartWith] = useState("");
  const [busy, setBusy] = useState<"" | "check" | "save">("");
  const [error, setError] = useState("");
  async function check() {
    setBusy("check");
    setError("");
    try {
      const listed = await coworkerBridge.localProviders.custom.probe(address, key);
      setModels(listed.models);
      setStartWith(listed.models[0] ?? "");
    } catch (cause) {
      setModels([]);
      setError(messageOf(cause));
    } finally {
      setBusy("");
    }
  }
  async function save() {
    setBusy("save");
    setError("");
    try {
      const ordered = [startWith, ...models.filter((model) => model !== startWith)].filter(Boolean);
      const result = await coworkerBridge.localProviders.custom.add({ name, address, key, models: ordered });
      setKey("");
      if (startWith && onStartModel) onStartModel(`${result.providerId}/${startWith}`);
      onSaved(COPY.connectedLine(result.modelCount), result.providerId);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy("");
    }
  }
  return (
    <form
      className="mt-3 ml-11 space-y-2"
      data-testid="custom-form"
      onSubmit={(event) => {
        event.preventDefault();
        void (models.length > 0 ? save() : check());
      }}
    >
      <div className="grid gap-2 md:grid-cols-2">
        <input className={inputClass} aria-label={COPY.customName} placeholder={COPY.customName} value={name} onChange={(event) => setName(event.target.value)} />
        <input className={`${inputClass} font-mono text-xs`} aria-label={COPY.customAddress} placeholder="http://127.0.0.1:1234" value={address} spellCheck={false} onChange={(event) => { setAddress(event.target.value); setModels([]); }} />
      </div>
      <input className={`${inputClass} font-mono text-xs`} type="password" autoComplete="off" spellCheck={false} aria-label={COPY.customKey} placeholder={COPY.customKey} value={key} onChange={(event) => setKey(event.target.value)} />
      {models.length > 0 ? (
        <label className="block text-[11px] text-mist">
          <span className="block">{COPY.customListed(models.length)} {COPY.customStart}:</span>
          <select className={`${inputClass} mt-1 bg-panel text-xs`} aria-label={COPY.customStart} value={startWith} onChange={(event) => setStartWith(event.target.value)} data-testid="custom-start-model">
            {models.map((model) => <option key={model} value={model}>{model}</option>)}
          </select>
        </label>
      ) : null}
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <div className="flex items-center gap-2">
        {models.length > 0 ? (
          <Button type="submit" variant="primary" disabled={busy !== "" || !name.trim()} aria-busy={busy === "save"}>{busy === "save" ? COPY.connecting : COPY.save}</Button>
        ) : (
          <Button type="submit" variant="primary" disabled={busy !== "" || !address.trim()} aria-busy={busy === "check"}>{busy === "check" ? "Checking…" : COPY.customCheck}</Button>
        )}
        <Button type="button" variant="ghost" onClick={onCancel}>{COPY.cancel}</Button>
      </div>
    </form>
  );
}

export function LocalProviders({
  runtime,
  session,
  onConnectAccount,
  onModelsChanged,
  onRuntimeChanged,
  onStartModel,
  chooseLabel,
}: {
  runtime: RuntimeInfo;
  session: DenSession | null;
  onConnectAccount: () => void;
  /** Something connected or disconnected: the model catalog changed. */
  onModelsChanged?: () => void;
  /** The platform restarted while getting ready; re-read runtime info. */
  onRuntimeChanged?: () => Promise<void>;
  /** The person picked a model to start with ("providerId/modelId"). */
  onStartModel?: (modelId: string) => void;
  /** What the free-model row's action says when `onStartModel` is given. */
  chooseLabel?: string;
}) {
  const [readiness, setReadiness] = useState<LocalProvidersReadiness>(EMPTY_READINESS);
  const [findings, setFindings] = useState<LocalProviderFinding[]>([]);
  const [catalog, setCatalog] = useState<EngineModelCatalog>(EMPTY_CATALOG);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [dismissed, setDismissed] = useState(readDismissed);
  const [states, setStates] = useState<Record<string, ConnectState>>({});
  const [adding, setAdding] = useState<"" | "list" | "custom" | string>("");
  const [disconnecting, setDisconnecting] = useState<{ providerId: string; note: string } | null>(null);
  const statesRef = useRef(states);
  statesRef.current = states;

  const setRowState = useCallback((id: string, next: ConnectState) => {
    setStates((current) => ({ ...current, [id]: next }));
  }, []);

  const refresh = useCallback(async (options: { clearRows?: boolean } = {}) => {
    setRefreshing(true);
    setError("");
    try {
      const ready = await coworkerBridge.localProviders.prepare();
      setReadiness(ready);
      // Getting the first workspace ready can move the platform to another port.
      if (ready.serverUrl && ready.serverUrl !== runtime.serverUrl) void onRuntimeChanged?.();
      const [detected, models] = await Promise.allSettled([
        coworkerBridge.localProviders.detect(),
        ready.engineManaged && ready.workspaceId
          ? createCoworkerThreads({ serverUrl: ready.serverUrl, workspaceId: ready.workspaceId, token: ready.ownerToken }).listModelCatalog()
          : Promise.resolve(EMPTY_CATALOG),
      ]);
      if (detected.status === "fulfilled") setFindings(detected.value.found);
      if (models.status === "fulfilled") setCatalog(models.value);
      const failed = [detected, models].find((entry): entry is PromiseRejectedResult => entry.status === "rejected");
      if (failed) setError(messageOf(failed.reason));
      // The Refresh control starts finished rows clean; a sign-in in progress is never wiped.
      if (options.clearRows) {
        const busy = new Set(busyProviderIds(statesRef.current));
        setStates((current) => Object.fromEntries(Object.entries(current).filter(([id]) => busy.has(id))));
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setRefreshing(false);
      setLoaded(true);
    }
  }, [onRuntimeChanged, runtime.serverUrl]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const plan = useMemo(() => planLocalMode({ findings, readiness, catalog }), [catalog, findings, readiness]);
  const freeModel = useMemo(() => pickFreeModel(catalog), [catalog]);

  const changed = useCallback(async () => {
    await refresh();
    onModelsChanged?.();
  }, [onModelsChanged, refresh]);

  async function connect(finding: LocalProviderFinding) {
    setRowState(finding.id, { phase: "connecting" });
    try {
      const result = await coworkerBridge.localProviders.connect(finding.id);
      setRowState(finding.id, connectReducer(IDLE, { type: "result", result }));
      if (result.status === "connected") await changed();
    } catch (cause) {
      setRowState(finding.id, connectReducer(IDLE, { type: "error", error: messageOf(cause), canSignIn: (readiness.signIns[finding.providerId]?.length ?? 0) > 0 }));
    }
  }

  async function signIn(rowId: string, providerId: string) {
    setRowState(rowId, { phase: "connecting" });
    try {
      const start = await coworkerBridge.localProviders.signIn.start(providerId);
      setRowState(rowId, connectReducer(IDLE, { type: "sign-in-started", start }));
      if (start.url) void coworkerBridge.openExternal(start.url);
    } catch (cause) {
      setRowState(rowId, connectReducer(IDLE, { type: "error", error: messageOf(cause) }));
    }
  }

  // Sign-ins in progress: ask the AI service how they are going.
  useEffect(() => {
    const waiting = Object.entries(states).filter((entry): entry is [string, Extract<ConnectState, { phase: "waiting" }>] => entry[1].phase === "waiting");
    if (waiting.length === 0) return;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      for (const [rowId, state] of waiting) {
        try {
          const status = await coworkerBridge.localProviders.signIn.status(state.attemptId);
          if (cancelled) return;
          const next = connectReducer(state, { type: "sign-in-status", status });
          if (next !== state) {
            setRowState(rowId, next);
            if (next.phase === "connected") void changed();
          }
        } catch {
          // The next tick asks again.
        }
      }
    }, SIGN_IN_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [changed, setRowState, states]);

  async function checkSignIn(rowId: string, state: Extract<ConnectState, { phase: "waiting" }>) {
    try {
      const status = await coworkerBridge.localProviders.signIn.status(state.attemptId);
      const next = connectReducer(state, { type: "sign-in-status", status });
      setRowState(rowId, next);
      if (next.phase === "connected") await changed();
    } catch (cause) {
      setRowState(rowId, connectReducer(IDLE, { type: "error", error: messageOf(cause) }));
    }
  }

  async function cancelSignIn(rowId: string, attemptId: string) {
    await coworkerBridge.localProviders.signIn.cancel(attemptId).catch(() => undefined);
    setRowState(rowId, IDLE);
  }

  async function disconnect(row: ConnectedRow, confirmed: boolean) {
    setError("");
    try {
      const result = await coworkerBridge.localProviders.disconnect(row.providerId, confirmed);
      if (result.needsConfirmation) {
        setDisconnecting({ providerId: row.providerId, note: result.note });
        return;
      }
      setDisconnecting(null);
      if (!result.removed) {
        setError(result.note);
        return;
      }
      await changed();
    } catch (cause) {
      setError(messageOf(cause));
    }
  }

  function rowAction(finding: LocalProviderFinding, state: ConnectState): ReactNode {
    if (finding.how === "unavailable") {
      return (
        <Button variant="ghost" onClick={() => setAdding(finding.providerId)} data-testid={`found-${finding.id}-add-key`}>{COPY.addKey}</Button>
      );
    }
    if (state.phase === "connecting") return <Button variant="ghost" disabled aria-busy>{COPY.connecting}</Button>;
    if (state.phase === "connected" || state.phase === "waiting") return null;
    if (state.phase === "failed") {
      return (
        <>
          {state.canSignIn ? <Button variant="ghost" onClick={() => void signIn(finding.id, finding.providerId)}>{COPY.signIn}</Button> : null}
          <Button variant="default" onClick={() => void connect(finding)}>{COPY.connect}</Button>
        </>
      );
    }
    return <Button variant="primary" onClick={() => void connect(finding)} data-testid={`found-${finding.id}-connect`}>{COPY.connect}</Button>;
  }

  function rowLine(finding: LocalProviderFinding, state: ConnectState): { line: string; tone?: "mint" | "amber" | "rose" } {
    if (state.phase === "connected") return { line: state.line, tone: "mint" };
    if (state.phase === "failed") return { line: state.error, tone: "rose" };
    if (finding.how === "unavailable") return { line: finding.reason, tone: "amber" };
    return { line: finding.detail };
  }

  const addableOpen = adding !== "";
  const addableChosen = plan.addable.find((provider) => provider.id === adding) ?? null;
  const addRowState = states["add-another"] ?? IDLE;

  return (
    <div className="space-y-5" data-testid="local-providers" data-loaded={loaded ? "true" : "false"}>
      {!session && !dismissed ? (
        <div className="flex items-center gap-3 rounded-xl border border-spark/25 bg-spark/8 px-3 py-2 text-[12px] text-snow" data-testid="local-mode-recommended">
          <span className="min-w-0 flex-1">{COPY.recommended}</span>
          <button type="button" className="shrink-0 font-medium text-[#b8caff] hover:underline" onClick={onConnectAccount}>{COPY.recommendedAction}</button>
          <button
            type="button"
            className="flex size-6 shrink-0 items-center justify-center rounded-full text-mist hover:bg-white/8 hover:text-snow"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={() => {
              writeDismissed();
              setDismissed(true);
            }}
          >
            <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
        </div>
      ) : null}

      <section>
        <div className="flex items-center justify-between gap-3">
          <GroupLabel count={plan.found.length > 0 ? plan.found.length : undefined}>{COPY.found}</GroupLabel>
          <button
            type="button"
            className="flex size-7 items-center justify-center rounded-full text-mist transition-colors hover:bg-white/8 hover:text-snow disabled:opacity-60"
            aria-label={COPY.refresh}
            title={COPY.refresh}
            disabled={refreshing}
            aria-busy={refreshing}
            data-testid="local-providers-refresh"
            onClick={() => void refresh({ clearRows: true })}
          >
            <RefreshIcon spinning={refreshing} />
          </button>
        </div>
        {loaded && plan.found.length === 0 ? <QuietLine testId="found-empty">{COPY.nothingFound}</QuietLine> : null}
        {plan.found.length > 0 ? (
          <ul className="px-1" aria-label={COPY.found} data-testid="found-rows">
            {plan.found.map((finding) => {
              // A row under Found is not connected now; a "connected" line left from earlier is stale.
              const remembered = states[finding.id] ?? IDLE;
              const state = remembered.phase === "connected" ? IDLE : remembered;
              const { line, tone } = rowLine(finding, state);
              return (
                <FlatRow
                  key={finding.id}
                  icon={iconFor(finding.kind)}
                  title={finding.label}
                  line={line}
                  tone={tone}
                  testId={`found-${finding.id}`}
                  extra={state.phase === "waiting" ? (
                    <SignInWait
                      state={state}
                      onOpen={() => void coworkerBridge.openExternal(state.url)}
                      onCheck={() => void checkSignIn(finding.id, state)}
                      onCancel={() => void cancelSignIn(finding.id, state.attemptId)}
                    />
                  ) : null}
                >
                  {rowAction(finding, state)}
                </FlatRow>
              );
            })}
          </ul>
        ) : null}
      </section>

      {plan.connected.length > 0 ? (
        <section>
          <GroupLabel count={plan.connected.length}>{COPY.connected}</GroupLabel>
          <ul className="px-1" aria-label={COPY.connected} data-testid="connected-rows">
            {plan.connected.map((row) => (
              <FlatRow
                key={row.providerId}
                icon={<KeyIcon />}
                title={row.label}
                line={disconnecting?.providerId === row.providerId ? disconnecting.note : row.detail}
                tone={disconnecting?.providerId === row.providerId ? "amber" : "mint"}
                testId={`connected-${row.providerId}`}
              >
                <span className="text-[11px] tabular-nums text-mist" data-testid={`connected-${row.providerId}-count`}>{row.modelCount} model{row.modelCount === 1 ? "" : "s"}</span>
                {onStartModel && chooseLabel ? (
                  <Button variant="ghost" onClick={() => {
                    const first = catalog.models.find((model) => model.providerId === row.providerId);
                    if (first) onStartModel(first.id);
                  }}>{chooseLabel}</Button>
                ) : null}
                {row.canDisconnect ? (
                  disconnecting?.providerId === row.providerId ? (
                    <>
                      <Button variant="danger" onClick={() => void disconnect(row, true)} data-testid={`connected-${row.providerId}-disconnect-anyway`}>{COPY.disconnectAnyway}</Button>
                      <Button variant="ghost" onClick={() => setDisconnecting(null)}>{COPY.keep}</Button>
                    </>
                  ) : (
                    <Button variant="ghost" onClick={() => void disconnect(row, false)} data-testid={`connected-${row.providerId}-disconnect`}>{COPY.disconnect}</Button>
                  )
                ) : null}
              </FlatRow>
            ))}
          </ul>
        </section>
      ) : null}

      <ul className="px-1" aria-label="More" data-testid="local-mode-more">
        <FlatRow
          icon={<GiftIcon />}
          title={COPY.freeTitle}
          line={loaded ? (plan.free.available ? COPY.freeDetail(plan.free.modelLabel) : COPY.freeUnavailable) : ""}
          tone={loaded && !plan.free.available ? "amber" : undefined}
          testId="free-model-row"
        >
          {onStartModel && chooseLabel && freeModel ? (
            <Button variant="default" onClick={() => onStartModel(freeModel.id)} data-testid="free-model-choose">{chooseLabel}</Button>
          ) : null}
        </FlatRow>
        <FlatRow
          icon={<PlusCircleIcon />}
          title={COPY.addAnother}
          line={addRowState.phase === "connected" ? addRowState.line : COPY.addAnotherDetail}
          tone={addRowState.phase === "connected" ? "mint" : undefined}
          testId="add-another-row"
          extra={addableOpen ? (
            <div className="mt-3 ml-11 space-y-3" data-testid="add-another">
              {adding === "list" ? (
                <div className="overflow-hidden rounded-xl border border-line bg-ink/60" role="listbox" aria-label={COPY.addAnother}>
                  {plan.addable.map((provider, index) => (
                    <OptionRow
                      key={provider.id}
                      letter={String.fromCharCode(65 + index)}
                      label={provider.label}
                      description={provider.connected ? "Connected" : provider.canSignIn && provider.acceptsKey ? "Sign in or paste a key" : provider.canSignIn ? "Sign in" : "Paste a key"}
                      onChoose={() => setAdding(provider.id)}
                    />
                  ))}
                  <OptionRow letter={String.fromCharCode(65 + plan.addable.length)} label={COPY.custom} description={COPY.customDetail} onChoose={() => setAdding("custom")} />
                </div>
              ) : null}
              {adding === "custom" ? (
                <CustomForm
                  onSaved={(line) => {
                    setAdding("");
                    setRowState("add-another", { phase: "connected", line });
                    void changed();
                  }}
                  onCancel={() => setAdding("")}
                  onStartModel={onStartModel}
                />
              ) : null}
              {addableChosen ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[12px] text-snow">{addableChosen.label}</p>
                    <button type="button" className="text-[11px] font-medium text-mist hover:text-snow" onClick={() => setAdding("list")}>{COPY.back}</button>
                  </div>
                  {addableChosen.canSignIn ? (
                    (states[`add:${addableChosen.id}`] ?? IDLE).phase === "waiting" ? null : (
                      <Button variant="default" onClick={() => void signIn(`add:${addableChosen.id}`, addableChosen.id)} data-testid={`add-${addableChosen.id}-sign-in`}>{COPY.signIn}</Button>
                    )
                  ) : null}
                  {(() => {
                    const state = states[`add:${addableChosen.id}`] ?? IDLE;
                    if (state.phase === "waiting") {
                      return (
                        <SignInWait
                          state={state}
                          onOpen={() => void coworkerBridge.openExternal(state.url)}
                          onCheck={() => void checkSignIn(`add:${addableChosen.id}`, state)}
                          onCancel={() => void cancelSignIn(`add:${addableChosen.id}`, state.attemptId)}
                        />
                      );
                    }
                    if (state.phase === "connected") return <p className="text-[11px] text-mint">{state.line}</p>;
                    if (state.phase === "failed") return <ErrorNote>{state.error}</ErrorNote>;
                    return null;
                  })()}
                  {addableChosen.acceptsKey ? (
                    <KeyForm
                      provider={addableChosen}
                      onSaved={(line) => {
                        setAdding("");
                        setRowState("add-another", { phase: "connected", line });
                        void changed();
                      }}
                      onCancel={() => setAdding("")}
                    />
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        >
          {addableOpen ? (
            <Button variant="ghost" onClick={() => setAdding("")}>{COPY.cancel}</Button>
          ) : (
            <Button variant="ghost" onClick={() => { setRowState("add-another", IDLE); setAdding("list"); }} data-testid="add-another-open">{COPY.choose}</Button>
          )}
        </FlatRow>
      </ul>

      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <p className="px-1 text-[11px] leading-relaxed text-mist" data-testid="local-mode-shared">{COPY.shared}</p>
      <TechnicalDetails entries={[
        { label: "Connected", value: plan.connected.map((row) => row.providerId).join(", ") },
        { label: "Found", value: findings.map((finding) => finding.id).join(", ") },
        { label: "Workspace", value: readiness.workspaceId },
      ]} />
    </div>
  );
}
