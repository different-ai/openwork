/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import { Activity } from "lucide-react";
import type { AgentContextDiagnosticsReport } from "@openwork/types/agent-context-diagnostics";

import { serializeAgentContextDiagnosticsReport } from "@/app/lib/agent-context-diagnostics";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { SettingsNotice } from "../settings-section";
import {
  AgentContextDiagnosticsErrorNotice,
  AgentContextDiagnosticsReportView,
} from "./agent-context-diagnostics-report";

const sectionHeaderClass = "flex flex-col gap-1";
const sectionTitleClass = "text-[15px] font-semibold tracking-[-0.2px] text-dls-text";
const sectionDescClass = "text-[12px] text-dls-secondary";
const cardClass =
  "rounded-2xl border border-dls-border bg-dls-surface/95 p-5 space-y-4";

export type AgentContextDiagnosticsSectionProps = {
  scopeKey: object;
  available: boolean;
  unavailableReason: "direct-remote-opencode" | null;
  onRun: () => Promise<AgentContextDiagnosticsReport>;
};

export type DiagnosticsScope = {
  key: object;
  generation: number;
};

export type DiagnosticsScopeIdentitySignals = {
  client: object | null;
  workspaceCredential: string;
  workspaceId: string;
  workspaceType: string;
  denBaseUrl: string;
  denCredential: string;
  denSignedIn: boolean;
  organizationId: string;
  principalId: string;
};

/**
 * `useMemo` owns the signal comparison. The value crossing into the diagnostics
 * section is deliberately an empty identity object so credentials and principal
 * fields can invalidate stale results without becoming readable report state.
 */
export function createOpaqueDiagnosticsScopeKey(
  _signals: DiagnosticsScopeIdentitySignals,
): object {
  return Object.freeze({});
}

export type ScopedDiagnosticsValue<T> = {
  scope: DiagnosticsScope;
  value: T;
};

export function readDiagnosticsValueForScope<T>(
  scoped: ScopedDiagnosticsValue<T> | null,
  scope: DiagnosticsScope,
): T | null {
  if (!scoped) return null;
  if (scoped.scope.key !== scope.key || scoped.scope.generation !== scope.generation) return null;
  return scoped.value;
}

type AgentDiagnosticsViewState = {
  report: AgentContextDiagnosticsReport | null;
  busy: boolean;
  copying: boolean;
  error: string | null;
  copied: boolean;
};

function emptyAgentDiagnosticsViewState(): AgentDiagnosticsViewState {
  return {
    report: null,
    busy: false,
    copying: false,
    error: null,
    copied: false,
  };
}

export function AgentContextDiagnosticsSection(props: AgentContextDiagnosticsSectionProps) {
  const diagnosticsRunRef = useRef(0);
  const diagnosticsInFlightRef = useRef<{ run: number; scope: DiagnosticsScope } | null>(null);
  const diagnosticsCopyRunRef = useRef(0);
  const diagnosticsCopyInFlightRef = useRef<{
    run: number;
    scope: DiagnosticsScope;
    report: AgentContextDiagnosticsReport;
  } | null>(null);
  const diagnosticsScopeRef = useRef<DiagnosticsScope>({
    key: props.scopeKey,
    generation: 0,
  });
  if (diagnosticsScopeRef.current.key !== props.scopeKey) {
    diagnosticsScopeRef.current = {
      key: props.scopeKey,
      generation: diagnosticsScopeRef.current.generation + 1,
    };
    diagnosticsInFlightRef.current = null;
    diagnosticsCopyRunRef.current += 1;
    diagnosticsCopyInFlightRef.current = null;
  }
  const diagnosticsScope = diagnosticsScopeRef.current;
  const [scopedDiagnosticsState, setScopedDiagnosticsState] = useState<ScopedDiagnosticsValue<AgentDiagnosticsViewState>>(() => ({
    scope: diagnosticsScope,
    value: emptyAgentDiagnosticsViewState(),
  }));
  const diagnosticsState = readDiagnosticsValueForScope(scopedDiagnosticsState, diagnosticsScope)
    ?? emptyAgentDiagnosticsViewState();

  useEffect(() => {
    setScopedDiagnosticsState((current) => readDiagnosticsValueForScope(current, diagnosticsScope) !== null
      ? current
      : { scope: diagnosticsScope, value: emptyAgentDiagnosticsViewState() });
  }, [diagnosticsScope]);

  const runAgentDiagnostics = async () => {
    const inFlight = diagnosticsInFlightRef.current;
    if (
      !props.available
      || (inFlight?.scope.key === diagnosticsScope.key
        && inFlight.scope.generation === diagnosticsScope.generation)
    ) return;
    const run = diagnosticsRunRef.current + 1;
    diagnosticsRunRef.current = run;
    const scope = diagnosticsScope;
    diagnosticsInFlightRef.current = { run, scope };
    diagnosticsCopyRunRef.current += 1;
    diagnosticsCopyInFlightRef.current = null;
    setScopedDiagnosticsState({
      scope,
      value: {
        report: null,
        busy: true,
        copying: false,
        error: null,
        copied: false,
      },
    });
    const isCurrentRun = () => {
      const currentScope = diagnosticsScopeRef.current;
      return diagnosticsRunRef.current === run
        && currentScope.key === scope.key
        && currentScope.generation === scope.generation;
    };
    try {
      const report = await props.onRun();
      if (!isCurrentRun()) return;
      setScopedDiagnosticsState({
        scope,
        value: {
          report,
          busy: true,
          copying: false,
          error: null,
          copied: false,
        },
      });
    } catch {
      if (!isCurrentRun()) return;
      setScopedDiagnosticsState({
        scope,
        value: {
          report: null,
          busy: true,
          copying: false,
          error: t("connect.diagnostics_run_failed"),
          copied: false,
        },
      });
    } finally {
      if (!isCurrentRun()) return;
      if (diagnosticsInFlightRef.current?.run === run) diagnosticsInFlightRef.current = null;
      setScopedDiagnosticsState((current) => {
        const value = readDiagnosticsValueForScope(current, scope);
        return value ? { scope, value: { ...value, busy: false } } : current;
      });
    }
  };

  const copyDiagnosticsReport = async () => {
    const scope = diagnosticsScope;
    const report = diagnosticsState.report;
    const currentScope = diagnosticsScopeRef.current;
    const inFlight = diagnosticsCopyInFlightRef.current;
    if (
      !report
      || currentScope.key !== scope.key
      || currentScope.generation !== scope.generation
      || (inFlight?.scope.key === scope.key
        && inFlight.scope.generation === scope.generation
        && inFlight.report === report)
    ) return;
    const run = diagnosticsCopyRunRef.current + 1;
    diagnosticsCopyRunRef.current = run;
    diagnosticsCopyInFlightRef.current = { run, scope, report };
    setScopedDiagnosticsState((current) => {
      const value = readDiagnosticsValueForScope(current, scope);
      if (!value || value.report !== report) return current;
      return {
        scope,
        value: {
          ...value,
          copying: true,
          copied: false,
          error: null,
        },
      };
    });
    const isCurrentCopy = () => {
      const latestScope = diagnosticsScopeRef.current;
      return diagnosticsCopyRunRef.current === run
        && latestScope.key === scope.key
        && latestScope.generation === scope.generation;
    };
    try {
      await navigator.clipboard.writeText(serializeAgentContextDiagnosticsReport(report));
      if (!isCurrentCopy()) return;
      setScopedDiagnosticsState((current) => {
        const value = readDiagnosticsValueForScope(current, scope);
        if (!value || value.report !== report) return current;
        return { scope, value: { ...value, copied: true, error: null } };
      });
    } catch {
      if (!isCurrentCopy()) return;
      setScopedDiagnosticsState((current) => {
        const value = readDiagnosticsValueForScope(current, scope);
        if (!value || value.report !== report) return current;
        return {
          scope,
          value: {
            ...value,
            copied: false,
            error: t("connect.diagnostics_copy_failed"),
          },
        };
      });
    } finally {
      if (!isCurrentCopy()) return;
      if (diagnosticsCopyInFlightRef.current?.run === run) diagnosticsCopyInFlightRef.current = null;
      setScopedDiagnosticsState((current) => {
        const value = readDiagnosticsValueForScope(current, scope);
        if (!value || value.report !== report) return current;
        return { scope, value: { ...value, copying: false } };
      });
    }
  };

  return (
    <div className={cardClass}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className={sectionHeaderClass}>
          <div className={sectionTitleClass}>{t("settings.agent_diagnostics_title")}</div>
          <div className={sectionDescClass}>{t("settings.agent_diagnostics_desc")}</div>
        </div>
        <Button
          data-testid="run-agent-diagnostics"
          size="sm"
          variant="outline"
          className="shrink-0"
          disabled={diagnosticsState.busy || !props.available}
          onClick={() => void runAgentDiagnostics()}
        >
          <Activity size={14} />
          {diagnosticsState.busy ? t("connect.diagnostics_running") : t("connect.diagnostics_run")}
        </Button>
      </div>
      {props.unavailableReason === "direct-remote-opencode" ? (
        <div data-testid="agent-diagnostics-unavailable-direct-opencode">
          <SettingsNotice>{t("connect.diagnostics_unavailable_direct_opencode")}</SettingsNotice>
        </div>
      ) : null}
      {diagnosticsState.error ? <AgentContextDiagnosticsErrorNotice message={diagnosticsState.error} /> : null}
      {diagnosticsState.report ? (
        <AgentContextDiagnosticsReportView
          report={diagnosticsState.report}
          copied={diagnosticsState.copied}
          copying={diagnosticsState.copying}
          onCopy={copyDiagnosticsReport}
        />
      ) : null}
    </div>
  );
}
