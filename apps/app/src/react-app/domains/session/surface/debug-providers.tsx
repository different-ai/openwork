/** @jsxImportSource react */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { createClient } from "@/app/lib/opencode";
import { createClientV2, isOpencodeV2BaseUrl } from "@/app/lib/opencode-v2-adapter";
import { getNativeSessionMessages } from "@/app/lib/opencode-session-native";
import type { ModelRef } from "@/app/types";
import { useProviderListQuery } from "@/react-app/infra/provider-list-query";
import { replyModelFromInfo } from "../sync/reply-model";
import type { ModelAvailabilityResolver } from "./model-availability";

function value(input: unknown, key: string): unknown {
  return input && typeof input === "object" ? Reflect.get(input, key) : undefined;
}
function count(input: unknown): number | null {
  return typeof input === "number" && Number.isFinite(input) && input >= 0 ? input : null;
}
function format(input: number | null) { return input === null ? "Not reported" : input.toLocaleString(); }

function Rows({ rows }: { rows: readonly (readonly [string, string | number])[] }) {
  return <table className="w-full table-fixed text-xs"><tbody>{rows.map(([label, text]) => (
    <tr key={label} className="border-b border-dls-border/50 last:border-0">
      <th scope="row" className="w-[43%] py-1.5 pr-2 text-left align-top font-normal">{label}</th>
      <td className="break-words py-1.5 text-right align-top font-mono text-dls-text">{text}</td>
    </tr>
  ))}</tbody></table>;
}

export function DebugProviders(props: {
  workspaceId: string;
  workspaceRoot: string;
  sessionId: string;
  threadTitle: string;
  baseUrl: string;
  token: string;
  selectedModel: ModelRef;
  variant: string | null;
  status: string;
  messageCount: number;
  historyComplete: boolean;
  resolveAvailability?: ModelAvailabilityResolver;
  onCopyThread: () => Promise<void>;
}) {
  // Null follows the focused thread's model, including changes made elsewhere.
  // Inspecting another provider never writes model selection or configuration.
  const [inspection, setInspection] = useState<ModelRef | null>(null);
  const [copying, setCopying] = useState(false);
  const engine = useMemo(() => isOpencodeV2BaseUrl(props.baseUrl)
    ? createClientV2(props.baseUrl, props.workspaceRoot, { token: props.token })
    : createClient(props.baseUrl, props.workspaceRoot, { mode: "openwork", token: props.token }),
  [props.baseUrl, props.workspaceRoot, props.token]);
  const providers = useProviderListQuery({ client: engine, baseUrl: props.baseUrl, directory: props.workspaceRoot });
  const history = useQuery({
    // Credential-scoped reads cannot reuse another signed-in identity's history.
    // Raw query keys are never rendered or included in diagnostic exports.
    queryKey: ["react-session-debug-thread", props.workspaceId, props.baseUrl, props.sessionId, props.token],
    queryFn: ({ signal }) => getNativeSessionMessages({ opencodeBaseUrl: props.baseUrl, token: props.token }, props.sessionId,
      { limit: 50, signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]) }),
    retry: false,
    refetchInterval: props.status === "idle" ? 5_000 : 2_500,
  });
  const inspected = inspection ?? props.selectedModel;
  const provider = providers.data?.all.find(item => item.id === inspected.providerID);
  const model = provider?.models[inspected.modelID];
  const availability = props.resolveAvailability?.(inspected);
  const connected = providers.data?.connected.includes(inspected.providerID) === true;
  const setup = providers.isError ? "Could not verify"
    : !providers.data || availability?.status === "pending" ? "Checking"
    : availability?.status === "unavailable" && availability.reason === "provider_blocked" ? "Blocked by policy"
    : availability?.status === "unavailable" ? availability.reason === "provider_not_connected" ? "Not connected" : "Model missing"
    : !connected ? "Not connected" : !model ? "Model missing" : "Configured";
  const messages = history.data ?? [];
  const replies = messages.filter(message => {
    const identity = replyModelFromInfo(message.info);
    return message.info.role === "assistant" && identity && (
      identity.providerID === inspected.providerID && identity.modelID === inspected.modelID
      || identity.requestedProviderID === inspected.providerID && identity.requestedModelID === inspected.modelID
    );
  }).toSorted((a, b) => a.info.time.created - b.info.time.created);
  const latest = replies.at(-1);
  const info = latest?.info;
  const identity = replyModelFromInfo(info);
  const tokens = value(info, "tokens");
  const cache = value(tokens, "cache");
  const input = count(value(tokens, "input"));
  const output = count(value(tokens, "output"));
  const cacheRead = count(value(cache, "read"));
  const cacheWrite = count(value(cache, "write"));
  // Some engines emit all-zero placeholders before usage is measured.
  const measured = [input, output, cacheRead, cacheWrite, count(value(tokens, "reasoning"))].some(item => item !== null && item > 0);
  const context = input === null || !measured ? null : input + (cacheRead ?? 0) + (cacheWrite ?? 0);
  const limit = model?.limit.context && model.limit.context > 0 ? model.limit.context : null;
  const resolvedLimit = identity?.resolved && identity.providerID
    ? providers.data?.all.find(item => item.id === identity.providerID)?.models[identity.modelID]?.limit.context : limit;
  const requestLimit = resolvedLimit && resolvedLimit > 0 ? resolvedLimit : null;
  const error = value(info, "error");
  const errorName = value(error, "name");
  const httpStatus = count(value(value(error, "data"), "statusCode"));
  const responseObserved = latest?.parts.some(part => (part.type === "text" || part.type === "reasoning") && part.text.length > 0)
    || (output !== null && output > 0);
  const response = history.isError ? "Could not verify" : !history.data ? "Checking"
    : error ? "Failed" : responseObserved ? "Response observed" : latest ? "No output reported" : "No response in recent history";
  const completed = count(value(value(info, "time"), "completed"));
  const elapsed = completed !== null && info ? Math.max(0, completed - info.time.created) : null;
  const cost = count(value(info, "cost"));
  const latestUser = messages.filter(item => item.info.role === "user").toSorted((a, b) => a.info.time.created - b.info.time.created).at(-1);
  const providerOptions = [...new Set([props.selectedModel.providerID, ...providers.data?.all.map(item => item.id) ?? [],
    ...messages.flatMap(item => { const model = replyModelFromInfo(item.info); return model?.providerID ? [model.providerID] : []; }),
  ])].filter(Boolean);
  const modelOptions = [...new Set([...(inspected.modelID ? [inspected.modelID] : []), ...Object.keys(provider?.models ?? {})])];
  const rows = [
    ["Setup", setup],
    ["Message flow", response],
    ["Context window", format(limit)],
    ["Last request context", context === null ? "Not reported" : `${format(context)}${requestLimit ? ` / ${format(requestLimit)} (${(context / requestLimit * 100).toFixed(1)}%)` : ""}`],
  ] as const;
  const details = [
    ["Thread", props.sessionId], ["Thread model", `${props.selectedModel.providerID} / ${props.selectedModel.modelID}`],
    ["Variant", props.variant ?? "Default"], ["Thread status", props.status],
    ["Source", provider?.source ?? "Not reported"], ["Available models", Object.keys(provider?.models ?? {}).length],
    ["Visible messages", props.messageCount], ["History loaded", props.historyComplete ? "Complete" : "Partial"],
    ["Inspection scope", "Latest 50 engine messages"],
    ["Engine messages", messages.length], ["Last stored prompt", latestUser?.info.id ?? "None"],
    ["Recent replies", replies.length], ["Last reply", info?.id ?? "None"],
    ["Reported model", identity ? `${identity.providerID ?? "Unknown"} / ${identity.modelID}` : "Not reported"],
    ["Routing evidence", identity?.resolved ? "Resolved by engine" : identity ? "Requested model only" : "Not reported"],
    ["Request context limit", format(requestLimit)],
    ["Input tokens", format(input)], ["Output tokens", format(output)],
    ["Reasoning tokens", format(count(value(tokens, "reasoning")))],
    ["Cache read / write", `${format(cacheRead)} / ${format(cacheWrite)}`],
    ["Output limit", format(model?.limit.output && model.limit.output > 0 ? model.limit.output : null)],
    ["Reply duration", elapsed === null ? "Not reported" : `${(elapsed / 1_000).toFixed(1)}s`],
    ["Reported cost", cost === null ? "Not reported" : `$${cost.toFixed(6)}`],
    ["Error type", typeof errorName === "string" ? errorName : error ? "Unclassified" : "None"],
    ["HTTP status", httpStatus ?? "Not reported"],
    ["Last checked", history.dataUpdatedAt ? new Date(history.dataUpdatedAt).toLocaleTimeString() : "Not checked"],
  ] as const;
  async function copyDetails() {
    try {
      // Allowlisted observations only: never provider options, keys, headers,
      // raw errors, URLs, paths, tool payloads, or conversation contents.
      await navigator.clipboard.writeText(JSON.stringify({ thread: props.sessionId,
        inspectedProvider: inspected.providerID, inspectedModel: inspected.modelID,
        observations: Object.fromEntries([...rows, ...details]),
      }, null, 2));
      toast.success("Provider details copied");
    } catch { toast.error("Could not copy provider details. Try again."); }
  }
  return <div data-testid="session-debug-providers" className="space-y-2 py-2 text-xs">
    <div className="flex items-center justify-between gap-2">
      <span className="truncate text-dls-text" title={props.sessionId}>{props.threadTitle || "Focused thread"}</span>
      <Button variant="link" size="xs" className="shrink-0 px-0 text-xs" disabled={copying} title="Copy the full conversation, including readable tool details"
        onClick={async () => { setCopying(true); try { await props.onCopyThread(); } finally { setCopying(false); } }}>Copy thread</Button>
    </div>
    <Select value={inspection ? inspected.providerID : "__focused_thread__"} onValueChange={id => {
      if (!id || id === "__focused_thread__") { setInspection(null); return; }
      setInspection({ providerID: id, modelID: id === props.selectedModel.providerID ? props.selectedModel.modelID
        : Object.keys(providers.data?.all.find(item => item.id === id)?.models ?? {})[0] ?? "" });
    }}>
      <SelectTrigger aria-label="Inspect provider" size="sm" className="w-full rounded-lg text-xs"><SelectValue>{inspection ? provider?.name ?? inspected.providerID : `Follow thread (${provider?.name ?? props.selectedModel.providerID})`}</SelectValue></SelectTrigger>
      <SelectContent><SelectItem value="__focused_thread__">Follow thread ({props.selectedModel.providerID})</SelectItem>
        {providerOptions.map(id => <SelectItem key={id} value={id}>{providers.data?.all.find(item => item.id === id)?.name ?? id}</SelectItem>)}
      </SelectContent>
    </Select>
    <Select value={inspected.modelID || null} onValueChange={id => { if (id) setInspection({ providerID: inspected.providerID, modelID: id }); }}>
      <SelectTrigger aria-label="Inspect model" size="sm" className="w-full rounded-lg text-xs"><SelectValue placeholder="No model available">{model?.name ?? (inspected.modelID || undefined)}</SelectValue></SelectTrigger>
      <SelectContent>{modelOptions.map(id => <SelectItem key={id} value={id}>{provider?.models[id]?.name ?? id}</SelectItem>)}</SelectContent>
    </Select>
    <div title="Context is the last reported input plus cache tokens. Setup does not verify credentials; response evidence comes from this thread."><Rows rows={rows} /></div>
    {history.isError || providers.isError ? <div className="text-destructive">Could not verify provider details. Refresh to try again.</div> : null}
    <div className="flex justify-between gap-2">
      <Button variant="link" size="xs" className="px-0 text-xs" onClick={() => { void providers.refetch(); void history.refetch(); }} disabled={history.isFetching || providers.isFetching}>Refresh provider details</Button>
      <Button variant="link" size="xs" className="px-0 text-xs" onClick={() => void copyDetails()}>Copy provider details</Button>
    </div>
    <Collapsible>
      <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="group w-full justify-start gap-1 px-0 text-xs" />}>
        <ChevronRight className="size-3 transition-transform group-data-panel-open:rotate-90" /> Thread details
      </CollapsibleTrigger>
      <CollapsibleContent><Rows rows={details} /></CollapsibleContent>
    </Collapsible>
  </div>;
}

/** Workspace-wide provider setup, shown when no thread is focused. */
export function DebugWorkspaceProviders(props: { workspaceRoot: string; baseUrl: string; token: string }) {
  const engine = useMemo(() => isOpencodeV2BaseUrl(props.baseUrl)
    ? createClientV2(props.baseUrl, props.workspaceRoot, { token: props.token })
    : createClient(props.baseUrl, props.workspaceRoot, { mode: "openwork", token: props.token }),
  [props.baseUrl, props.workspaceRoot, props.token]);
  const providers = useProviderListQuery({ client: engine, baseUrl: props.baseUrl, directory: props.workspaceRoot });
  const connected = new Set(providers.data?.connected ?? []);
  // Connected providers first; the list never includes credentials or options.
  const list = (providers.data?.all ?? []).toSorted((a, b) =>
    Number(connected.has(b.id)) - Number(connected.has(a.id)) || a.name.localeCompare(b.name));
  return <div data-testid="session-debug-workspace-providers" className="space-y-2 py-2 text-xs">
    <div className="flex items-center justify-between gap-2">
      <span className="text-dls-text">No thread selected</span>
      <Button variant="link" size="xs" className="px-0 text-xs" disabled={providers.isFetching} onClick={() => void providers.refetch()}>Refresh providers</Button>
    </div>
    {providers.isError ? <div className="text-destructive">Could not load providers. Refresh to try again.</div>
      : !providers.data ? <div>Checking</div>
      : <Rows rows={[
        ["Connected providers", `${connected.size} / ${list.length}`],
        ...list.map(item => [item.name || item.id,
          `${connected.has(item.id) ? "Connected" : "Not connected"} · ${Object.keys(item.models).length} models`] as const),
      ]} />}
  </div>;
}
