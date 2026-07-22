/** @jsxImportSource react */
import { useMemo, useState } from "react";
import { CircleAlert, Copy } from "lucide-react";
import {
  formatObservabilityEvent,
  OBSERVABILITY_CONTENT_MODES,
  OBSERVABILITY_LEVELS,
  OBSERVABILITY_SCOPES,
  type ObservabilityContentMode,
  type ObservabilityLevel,
  type ObservabilityScope,
} from "@openwork/observability";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useObservability } from "@/react-app/shell/observability-provider";

const cardClass = "rounded-2xl border border-dls-border bg-dls-surface/95 p-5 space-y-4";
const labelClass = "text-[11px] font-medium uppercase tracking-wider text-dls-secondary";
const selectClass = "w-full sm:w-48";

function statusLabel(status: ReturnType<typeof useObservability>["status"]) {
  if (status === "connected") return "live";
  if (status === "connecting") return "connecting";
  if (status === "error") return "connection error";
  return "off";
}

export function ObservabilityPanel() {
  const {
    config,
    events,
    droppedCount,
    status,
    statusMessage,
    updateConfig,
    clear,
  } = useObservability();
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const formattedEvents = useMemo(
    () => events.map((event) => `[openwork:${event.scope}] ${formatObservabilityEvent(event)}`),
    [events],
  );

  const toggleScope = (scope: ObservabilityScope) => {
    const scopes = config.scopes.includes(scope)
      ? config.scopes.filter((value) => value !== scope)
      : [...config.scopes, scope];
    updateConfig({ scopes });
  };

  const copyEvents = async () => {
    try {
      await navigator.clipboard.writeText(formattedEvents.join("\n"));
      setCopyStatus(`Copied ${formattedEvents.length} observability events.`);
    } catch (error) {
      setCopyStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const maxEventOptions = [...new Set([250, 1_000, 2_500, 5_000, config.maxEvents])]
    .sort((left, right) => left - right);

  return (
    <div className={cardClass}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[15px] font-semibold tracking-[-0.2px] text-dls-text">
            OpenCode observability
          </div>
          <div className="text-[12px] text-dls-secondary">
            Trace engine lifecycle, prompt construction, MCP failures, tools, and raw event provenance.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${status === "connected" ? "bg-green-9" : status === "error" ? "bg-red-9" : "bg-amber-9"}`} />
          <span className="text-[11px] font-medium uppercase tracking-wider text-dls-secondary">
            {statusLabel(status)}
          </span>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <label className="space-y-1.5">
          <span className={labelClass}>Minimum level</span>
          <Select
            value={config.level}
            onValueChange={(value) => updateConfig({ level: value as ObservabilityLevel })}
          >
            <SelectTrigger className={selectClass} aria-label="Minimum observability level">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {OBSERVABILITY_LEVELS.map((level) => (
                  <SelectItem key={level} value={level}>{level}</SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </label>

        <label className="space-y-1.5">
          <span className={labelClass}>Content detail</span>
          <Select
            value={config.content}
            onValueChange={(value) => updateConfig({ content: value as ObservabilityContentMode })}
          >
            <SelectTrigger className={selectClass} aria-label="Observability content detail">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {OBSERVABILITY_CONTENT_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>{mode}</SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </label>

        <label className="space-y-1.5">
          <span className={labelClass}>Retained events</span>
          <Select
            value={String(config.maxEvents)}
            onValueChange={(value) => updateConfig({ maxEvents: Number(value) })}
          >
            <SelectTrigger className={selectClass} aria-label="Retained observability events">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {maxEventOptions.map((count) => (
                  <SelectItem key={count} value={String(count)}>{count.toLocaleString()}</SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </label>
      </div>

      <div className="space-y-2">
        <div className={labelClass}>Scopes</div>
        <div className="flex flex-wrap gap-2">
          {OBSERVABILITY_SCOPES.map((scope) => {
            const selected = config.scopes.includes(scope);
            return (
              <Button
                key={scope}
                type="button"
                size="xs"
                variant={selected ? "secondary" : "outline"}
                aria-pressed={selected}
                onClick={() => toggleScope(scope)}
              >
                {scope}
              </Button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dls-border bg-dls-sidebar/40 p-3">
        <div>
          <div className="text-[12px] font-medium text-dls-text">Mirror events to DevTools console</div>
          <div className="text-[11px] text-dls-secondary">Uses a stable [openwork:scope] prefix for filtering.</div>
        </div>
        <Switch
          checked={config.console}
          onCheckedChange={(checked) => updateConfig({ console: checked })}
          aria-label="Mirror observability events to the developer console"
        />
      </div>

      {config.content === "full" ? (
        <div className="flex gap-2 rounded-xl border border-red-7/50 bg-red-3/40 p-3 text-[12px] text-red-11">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div className="font-semibold">Sensitive full-content capture is enabled.</div>
            <div>Prompts and raw event payloads can contain private workspace data. Disable it before sharing logs.</div>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-[11px] text-dls-secondary">
          {events.length.toLocaleString()} visible · {droppedCount.toLocaleString()} dropped or evicted
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void clear()}>
            Clear
          </Button>
          <Button variant="outline" size="sm" onClick={() => void copyEvents()} disabled={events.length === 0}>
            <Copy size={13} className="mr-1.5" />
            Copy
          </Button>
        </div>
      </div>

      {statusMessage ? (
        <div className="rounded-lg border border-red-6 bg-red-3/40 px-3 py-2 text-[11px] text-red-11">
          {statusMessage}
        </div>
      ) : null}
      {copyStatus ? <div className="text-[11px] text-dls-secondary">{copyStatus}</div> : null}

      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-dls-border bg-dls-sidebar/40 p-3 text-[11px] font-mono text-dls-text">
        {formattedEvents.length > 0
          ? formattedEvents.join("\n")
          : "No events yet. Trigger an OpenCode action to start the trace."}
      </pre>
    </div>
  );
}
