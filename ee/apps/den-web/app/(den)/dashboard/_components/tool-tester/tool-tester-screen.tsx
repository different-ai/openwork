"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  Loader2,
  Play,
  RefreshCw,
  Shield,
  Trash2,
  Wrench,
} from "lucide-react";
import { DenBadge } from "../../../_components/ui/badge";
import { DenButton } from "../../../_components/ui/button";
import { DashboardPageTemplate } from "../../../_components/ui/dashboard-page-template";
import { DenNotice } from "../../../_components/ui/notice";
import { DenSelect } from "../../../_components/ui/select";
import { DenToggleRow } from "../../../_components/ui/toggle-row";
import { DenRequestTimeoutError } from "../../../_lib/den-flow";
import { getMcpConnectionsRoute, getOrgAccessFlags } from "../../../_lib/den-org";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { marketplaceConnectionNeedsAdminSetup } from "../mcp-connection-setup";
import {
  type ExternalMcpConnection,
  type ExternalMcpTool,
  type ExternalMcpToolPolicyView,
  ExternalMcpToolPolicyBlockedError,
  ExternalMcpToolRunError,
  isNativeProviderConnectionId,
  useMcpConnections,
  useMcpConnectionPresets,
  useMcpConnectionTools,
  useRunMcpConnectionTool,
  useUpdateMcpConnectionToolPolicy,
} from "../mcp-connections-data";
import { attributeExternalMcpToolFailure } from "../mcp-tool-error-attribution";
import {
  ToolArgumentsEditor,
  type ToolArgumentsEditorMode,
} from "./arguments-editor";
import {
  formValuesFromArguments,
  schemaSupportsForm,
  serializeFormValues,
} from "./schema-form";
import { RecentToolRuns, type StoredToolRun } from "./recent-runs";
import {
  formatJson,
  McpToolCallInspector,
  type McpToolCallOutcome,
  mcpToolArgumentTemplate,
} from "./tool-call-inspector";
import { ToolRail } from "./tool-rail";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolTitle(tool: ExternalMcpTool): string {
  return tool.title || tool.annotations?.title || tool.name;
}

function relativeDate(value: string | null): string | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (elapsedMinutes < 1) return "just now";
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
  const hours = Math.floor(elapsedMinutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function policyAttribution(policy: ExternalMcpToolPolicyView): string {
  if (!policy.updatedBy) return "";
  const updated = relativeDate(policy.updatedAt);
  return updated ? ` by ${policy.updatedBy} · ${updated}` : ` by ${policy.updatedBy}`;
}

function testableConnection(
  connection: ExternalMcpConnection,
  isAdmin: boolean,
  needsAdminSetup: boolean,
): boolean {
  return isAdmin
    && !isNativeProviderConnectionId(connection.id, connection.nativeProviderKey)
    && (connection.credentialMode === "shared" ? connection.connected : connection.connectedForMe)
    && connection.needsReconnect !== true
    && !needsAdminSetup;
}

export function ToolTesterScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const requestedConnectionId = searchParams.get("connectionId");
  const { orgContext, orgSlug } = useOrgDashboard();
  const access = getOrgAccessFlags(
    orgContext?.currentMember.role ?? "member",
    orgContext?.currentMember.isOwner ?? false,
    orgContext?.roles,
  );
  const connectionsQuery = useMcpConnections("manageable");
  const presetsQuery = useMcpConnectionPresets();
  const testableConnections = useMemo(() => (
    (connectionsQuery.data ?? []).filter((connection) => testableConnection(
      connection,
      access.isAdmin,
      marketplaceConnectionNeedsAdminSetup(connection, presetsQuery.data ?? []),
    ))
  ), [access.isAdmin, connectionsQuery.data, presetsQuery.data]);
  const [selectedConnectionId, setSelectedConnectionId] = useState(requestedConnectionId ?? "");
  const [selectedToolName, setSelectedToolName] = useState("");
  const [toolSearch, setToolSearch] = useState("");
  const [argumentsText, setArgumentsText] = useState("{}");
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [editorMode, setEditorMode] = useState<ToolArgumentsEditorMode>("json");
  const [showOptionalFields, setShowOptionalFields] = useState(false);
  const [destructiveConfirmed, setDestructiveConfirmed] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [disableAllConfirmOpen, setDisableAllConfirmOpen] = useState(false);
  const [recentRuns, setRecentRuns] = useState<StoredToolRun[]>([]);
  const [currentRun, setCurrentRun] = useState<StoredToolRun | null>(null);
  const [pendingLoad, setPendingLoad] = useState<StoredToolRun | null>(null);

  const selectedConnection = testableConnections.find((connection) => connection.id === selectedConnectionId) ?? null;
  const catalog = useMcpConnectionTools(selectedConnectionId, Boolean(selectedConnection));
  const updatePolicy = useUpdateMcpConnectionToolPolicy(selectedConnectionId);
  const runTool = useRunMcpConnectionTool(selectedConnectionId);
  const tools = useMemo(() => catalog.data?.tools ?? [], [catalog.data]);
  const policy = catalog.data?.policy ?? null;
  const selectedTool = tools.find((tool) => tool.name === selectedToolName) ?? null;
  const selectedToolDisabled = Boolean(policy && selectedTool && (
    policy.allDisabled || policy.disabledTools.includes(selectedTool.name)
  ));

  useEffect(() => {
    if (testableConnections.length === 0) return;
    if (testableConnections.some((connection) => connection.id === selectedConnectionId)) return;
    const nextConnection = testableConnections.find((connection) => connection.id === requestedConnectionId)
      ?? testableConnections[0];
    if (!nextConnection) return;
    setSelectedConnectionId(nextConnection.id);
    router.replace(`${pathname}?connectionId=${encodeURIComponent(nextConnection.id)}`);
  }, [pathname, requestedConnectionId, router, selectedConnectionId, testableConnections]);

  useEffect(() => {
    if (pendingLoad && pendingLoad.connectionId === selectedConnectionId) {
      const loadedTool = tools.find((tool) => tool.name === pendingLoad.toolName);
      if (loadedTool) {
        let parsedArguments: unknown;
        try {
          parsedArguments = JSON.parse(pendingLoad.argumentsText);
        } catch {
          parsedArguments = null;
        }
        setSelectedToolName(loadedTool.name);
        setArgumentsText(pendingLoad.argumentsText);
        setFormValues(isRecord(parsedArguments) ? formValuesFromArguments(loadedTool.inputSchema, parsedArguments) : {});
        setEditorMode(schemaSupportsForm(loadedTool.inputSchema) ? "form" : "json");
        setShowOptionalFields(false);
        setDestructiveConfirmed(false);
        setLocalError(null);
        setCurrentRun(pendingLoad);
        setPendingLoad(null);
        return;
      }
    }
    if (tools.length === 0 || tools.some((tool) => tool.name === selectedToolName)) return;
    const firstTool = tools[0];
    if (!firstTool) return;
    const template = mcpToolArgumentTemplate(firstTool);
    setSelectedToolName(firstTool.name);
    setArgumentsText(formatJson(template));
    setFormValues(formValuesFromArguments(firstTool.inputSchema, template));
    setEditorMode(schemaSupportsForm(firstTool.inputSchema) ? "form" : "json");
    setShowOptionalFields(false);
    setDestructiveConfirmed(false);
    setLocalError(null);
    setCurrentRun(null);
  }, [pendingLoad, selectedConnectionId, selectedToolName, tools]);

  useEffect(() => {
    if (selectedTool && !schemaSupportsForm(selectedTool.inputSchema) && editorMode !== "json") {
      setEditorMode("json");
    }
  }, [editorMode, selectedTool]);

  function replaceConnectionQuery(connectionId: string) {
    router.replace(`${pathname}?connectionId=${encodeURIComponent(connectionId)}`);
  }

  function chooseConnection(connectionId: string) {
    setSelectedConnectionId(connectionId);
    setSelectedToolName("");
    setToolSearch("");
    setArgumentsText("{}");
    setFormValues({});
    setLocalError(null);
    setPolicyError(null);
    setCurrentRun(null);
    setPendingLoad(null);
    setDisableAllConfirmOpen(false);
    runTool.reset();
    replaceConnectionQuery(connectionId);
  }

  function chooseTool(tool: ExternalMcpTool) {
    const template = mcpToolArgumentTemplate(tool);
    setSelectedToolName(tool.name);
    setArgumentsText(formatJson(template));
    setFormValues(formValuesFromArguments(tool.inputSchema, template));
    setEditorMode(schemaSupportsForm(tool.inputSchema) ? "form" : "json");
    setShowOptionalFields(false);
    setDestructiveConfirmed(false);
    setLocalError(null);
    setCurrentRun(null);
    runTool.reset();
  }

  function clearRunFeedback() {
    setLocalError(null);
    setCurrentRun(null);
    runTool.reset();
  }

  function changeEditorMode(nextMode: ToolArgumentsEditorMode) {
    if (!selectedTool || nextMode === editorMode) return;
    if (nextMode === "json") {
      setArgumentsText(formatJson(serializeFormValues(selectedTool.inputSchema, formValues)));
      setEditorMode("json");
      clearRunFeedback();
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(argumentsText);
    } catch {
      setLocalError("Arguments must be valid JSON before switching to Form.");
      return;
    }
    if (!isRecord(parsed)) {
      setLocalError("Arguments must be a JSON object before switching to Form.");
      return;
    }
    setFormValues(formValuesFromArguments(selectedTool.inputSchema, parsed));
    setEditorMode("form");
    clearRunFeedback();
  }

  function changeFormValue(name: string, value: string) {
    setFormValues((values) => ({ ...values, [name]: value }));
    clearRunFeedback();
  }

  async function savePolicy(nextPolicy: Pick<ExternalMcpToolPolicyView, "allDisabled" | "disabledTools">): Promise<boolean> {
    setPolicyError(null);
    try {
      await updatePolicy.mutateAsync(nextPolicy);
      return true;
    } catch (error) {
      setPolicyError(error instanceof Error ? error.message : "Failed to update the tool policy.");
      return false;
    }
  }

  async function toggleTool(toolName: string, enabled: boolean) {
    if (!policy) return;
    const disabledTools = enabled
      ? policy.disabledTools.filter((name) => name !== toolName)
      : [...new Set([...policy.disabledTools, toolName])];
    await savePolicy({ allDisabled: policy.allDisabled, disabledTools });
  }

  async function enableSelectedTool() {
    if (!policy || !selectedTool) return;
    await savePolicy({
      allDisabled: false,
      disabledTools: policy.disabledTools.filter((name) => name !== selectedTool.name),
    });
  }

  function rememberRun(run: StoredToolRun) {
    setCurrentRun(run);
    setRecentRuns((runs) => [run, ...runs].slice(0, 20));
  }

  async function handleRun() {
    if (!selectedTool || !selectedConnection || selectedToolDisabled) return;
    setLocalError(null);
    setCurrentRun(null);
    runTool.reset();
    let parsed: unknown;
    if (editorMode === "form") {
      parsed = serializeFormValues(selectedTool.inputSchema, formValues);
    } else {
      try {
        parsed = JSON.parse(argumentsText);
      } catch {
        setLocalError("Arguments must be valid JSON.");
        return;
      }
    }
    if (!isRecord(parsed)) {
      setLocalError("Arguments must be a JSON object, such as {}.");
      return;
    }
    if (selectedTool.annotations?.destructiveHint && !destructiveConfirmed) {
      setLocalError("Confirm the destructive tool warning before running this tool.");
      return;
    }

    const startedAt = Date.now();
    const runArgumentsText = formatJson(parsed);
    try {
      const result = await runTool.mutateAsync({ toolName: selectedTool.name, arguments: parsed });
      const outcome: McpToolCallOutcome = {
        status: "completed",
        referenceId: result.referenceId,
        durationMs: result.durationMs,
        result: result.result,
        inspection: result.inspection,
        failureAttribution: null,
        errorMessage: null,
      };
      rememberRun({
        id: crypto.randomUUID(),
        connectionId: selectedConnection.id,
        toolName: selectedTool.name,
        argumentsText: runArgumentsText,
        createdAt: Date.now(),
        status: "completed",
        outcome,
      });
    } catch (error) {
      if (error instanceof ExternalMcpToolPolicyBlockedError) {
        rememberRun({
          id: crypto.randomUUID(),
          connectionId: selectedConnection.id,
          toolName: selectedTool.name,
          argumentsText: runArgumentsText,
          createdAt: Date.now(),
          status: "policy_blocked",
          message: error.message,
          disabledBy: error.disabledBy,
          disabledAt: error.disabledAt,
        });
        void catalog.refetch();
        return;
      }
      const serverFailure = error instanceof ExternalMcpToolRunError ? error : null;
      const browserTimeout = error instanceof DenRequestTimeoutError ? error : null;
      const inspection = serverFailure?.inspection ?? null;
      const failureAttribution = serverFailure || browserTimeout
        ? attributeExternalMcpToolFailure({
            diagnostic: serverFailure?.diagnostic ?? null,
            inspection,
            browserTimeout,
            mayHaveSideEffects: selectedTool.annotations?.readOnlyHint !== true,
          })
        : null;
      const message = error instanceof Error ? error.message : "The MCP tool failed.";
      const outcome: McpToolCallOutcome = {
        status: "failed",
        referenceId: failureAttribution?.diagnosticReference ?? serverFailure?.diagnostic?.referenceId ?? "No reference",
        durationMs: inspection?.response?.durationMs ?? Date.now() - startedAt,
        result: { error: message, diagnostic: serverFailure?.diagnostic ?? null },
        inspection,
        failureAttribution,
        errorMessage: message,
      };
      rememberRun({
        id: crypto.randomUUID(),
        connectionId: selectedConnection.id,
        toolName: selectedTool.name,
        argumentsText: runArgumentsText,
        createdAt: Date.now(),
        status: "failed",
        outcome,
      });
    }
  }

  function loadRun(run: StoredToolRun) {
    if (!testableConnections.some((connection) => connection.id === run.connectionId)) return;
    setPendingLoad(run);
    setCurrentRun(run);
    if (run.connectionId !== selectedConnectionId) {
      setSelectedConnectionId(run.connectionId);
      setSelectedToolName("");
      replaceConnectionQuery(run.connectionId);
    }
  }

  return (
    <DashboardPageTemplate
      icon={Wrench}
      title="Tool Tester"
      colors={["#CFFAFE", "#155E75", "#0E7490", "#67E8F9"]}
      description="Run any tool your connections expose, inspect the request on the wire, and control which tools your organization can use. Runs execute with your credential and are never written to OpenWork logs."
    >
      {connectionsQuery.error ? (
        <DenNotice className="mb-4" message={connectionsQuery.error instanceof Error ? connectionsQuery.error.message : "Failed to load connections."} />
      ) : null}

      {connectionsQuery.isLoading || presetsQuery.isLoading ? (
        <div className="flex items-center gap-2 rounded-2xl border border-gray-100 bg-white px-5 py-6 text-[13px] text-gray-500">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading testable connections…
        </div>
      ) : testableConnections.length === 0 ? (
        <DenNotice
          tone="neutral"
          message={<span>No connected, testable MCP connections are available. <Link className="font-medium text-gray-900 underline" href={getMcpConnectionsRoute(orgSlug)}>Add or connect a connector first.</Link></span>}
        />
      ) : selectedConnection ? (
        <div className="space-y-5">
          <div className="flex flex-col gap-3 rounded-2xl border border-gray-100 bg-white p-4 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1 sm:max-w-sm">
              <DenSelect aria-label="Connection" value={selectedConnection.id} onChange={(event) => chooseConnection(event.target.value)}>
                {testableConnections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
              </DenSelect>
            </div>
            <DenBadge tone={selectedConnection.connectedForMe ? "success" : "neutral"}>
              {selectedConnection.connectedForMe ? "Connected as you" : "Not connected"}
            </DenBadge>
            <DenButton
              className="shrink-0 whitespace-nowrap sm:ml-auto"
              variant="secondary"
              size="sm"
              icon={RefreshCw}
              loading={catalog.isFetching}
              onClick={() => void catalog.refetch()}
            >
              Refresh tools
            </DenButton>
          </div>

          {catalog.isLoading ? (
            <div className="flex items-center gap-2 rounded-2xl border border-gray-100 bg-white px-5 py-8 text-[13px] text-gray-500">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Reading the MCP tool catalog…
            </div>
          ) : catalog.error ? (
            <DenNotice message={catalog.error instanceof Error ? catalog.error.message : "Could not read this MCP's tools."} />
          ) : policy ? (
            <>
              <div className="space-y-3">
                <DenToggleRow
                  icon={Shield}
                  title="Tools enabled for your organization"
                  description={`Turn off to block every ${selectedConnection.name} tool at the OpenWork layer — agents can't discover or call them, members can't run them.`}
                  checked={!policy.allDisabled}
                  disabled={updatePolicy.isPending}
                  onChange={(checked) => {
                    if (checked) {
                      void savePolicy({ allDisabled: false, disabledTools: policy.disabledTools });
                    } else {
                      setDisableAllConfirmOpen(true);
                    }
                  }}
                />
                {policy.allDisabled ? (
                  <DenNotice
                    tone="warning"
                    message={`${selectedConnection.name} tools are disabled for your organization. Agents can't discover or call them, and members can't run them from OpenWork.${policy.updatedBy ? ` Turned off${policyAttribution(policy)}` : ""}`}
                  />
                ) : null}
                {policyError ? <DenNotice message={policyError} /> : null}
              </div>

              {tools.length === 0 ? (
                <DenNotice tone="neutral" message="This MCP is connected but does not currently expose any tools." />
              ) : (
                <div className="flex flex-col items-start gap-4 lg:flex-row">
                  <ToolRail
                    tools={tools}
                    selectedToolName={selectedToolName}
                    policy={policy}
                    search={toolSearch}
                    policyAttribution={policyAttribution(policy)}
                    policyUpdating={updatePolicy.isPending}
                    onSearchChange={setToolSearch}
                    onSelect={chooseTool}
                    onToggle={(toolName, enabled) => void toggleTool(toolName, enabled)}
                  />

                  {selectedTool ? (
                    <section className="min-w-0 flex-1 rounded-2xl border border-gray-100 bg-white p-5">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h2 className="text-[16px] font-semibold tracking-tight text-gray-950">{toolTitle(selectedTool)}</h2>
                            {selectedTool.annotations?.readOnlyHint ? (
                              <DenBadge tone="success">Read-only</DenBadge>
                            ) : selectedTool.annotations?.destructiveHint ? (
                              <DenBadge tone="danger" icon={Trash2}>Destructive</DenBadge>
                            ) : (
                              <DenBadge tone="warning" icon={AlertTriangle}>Not marked read-only</DenBadge>
                            )}
                            {selectedToolDisabled ? <DenBadge tone="neutral">Disabled</DenBadge> : null}
                          </div>
                          {selectedTool.description ? <p className="mt-2 text-[12.5px] leading-5 text-gray-500">{selectedTool.description}</p> : null}
                        </div>
                        <p className="max-w-full break-all text-right font-mono text-[11px] text-gray-400">{selectedTool.name}</p>
                      </div>

                      {currentRun?.status === "policy_blocked" ? <div className="mt-5"><DenNotice message={currentRun.message} /></div> : null}

                      {selectedToolDisabled ? (
                        <div className="mt-5 space-y-3">
                          <DenNotice
                            tone="warning"
                            message={`Disabled for your organization${policyAttribution(policy)}. Agents can't call it and members can't run it. Re-enable it to test it here.`}
                          />
                          <div className="flex flex-wrap gap-2">
                            <DenButton size="md" icon={Play} disabled>Run tool</DenButton>
                            <DenButton variant="secondary" size="md" loading={updatePolicy.isPending} onClick={() => void enableSelectedTool()}>Enable tool</DenButton>
                          </div>
                        </div>
                      ) : (
                        <div className="mt-5 space-y-4">
                          <ToolArgumentsEditor
                            tool={selectedTool}
                            mode={editorMode}
                            formValues={formValues}
                            argumentsText={argumentsText}
                            showOptionalFields={showOptionalFields}
                            disabled={runTool.isPending}
                            onModeChange={changeEditorMode}
                            onFormValueChange={changeFormValue}
                            onArgumentsTextChange={(value) => {
                              setArgumentsText(value);
                              clearRunFeedback();
                            }}
                            onToggleOptionalFields={() => setShowOptionalFields((visible) => !visible)}
                          />

                          {selectedTool.annotations?.destructiveHint ? (
                            <label className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[12px] leading-5 text-red-700">
                              <input
                                type="checkbox"
                                className="mt-1"
                                checked={destructiveConfirmed}
                                onChange={(event) => setDestructiveConfirmed(event.target.checked)}
                              />
                              <span><strong>Destructive tool warning.</strong> The provider says this tool may change or delete external data. I want to run it with these arguments.</span>
                            </label>
                          ) : selectedTool.annotations?.readOnlyHint ? (
                            <p className="inline-flex items-center gap-1.5 text-[11px] font-medium text-blue-700">
                              <Check className="h-3.5 w-3.5" /> Provider marks this tool as read-only.
                            </p>
                          ) : (
                            <p className="inline-flex items-center gap-1.5 text-[11px] font-medium text-amber-700">
                              <AlertTriangle className="h-3.5 w-3.5" /> The provider did not mark this tool as read-only. Review the arguments before running it.
                            </p>
                          )}

                          {localError ? <DenNotice message={localError} /> : null}
                          <div className="flex flex-wrap items-center gap-3">
                            <DenButton size="md" icon={Play} loading={runTool.isPending} onClick={() => void handleRun()}>Run tool</DenButton>
                            <p className="text-[11px] text-gray-500">Runs immediately against {selectedConnection.name}, as you.</p>
                          </div>
                        </div>
                      )}

                      {currentRun && currentRun.status !== "policy_blocked" ? (
                        <div className="mt-5"><McpToolCallInspector key={currentRun.id} outcome={currentRun.outcome} /></div>
                      ) : null}
                    </section>
                  ) : null}
                </div>
              )}

              <RecentToolRuns
                runs={recentRuns}
                caption="Kept in this browser for this session only — OpenWork never stores run results."
                onLoad={loadRun}
              />
            </>
          ) : null}
        </div>
      ) : null}

      {disableAllConfirmOpen && selectedConnection && policy ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-6" onClick={updatePolicy.isPending ? undefined : () => setDisableAllConfirmOpen(false)}>
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="disable-tools-title"
            aria-describedby="disable-tools-description"
            className="w-full max-w-md rounded-[28px] border border-gray-200 bg-white p-6 shadow-[0_24px_80px_-32px_rgba(15,23,42,0.45)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-600"><Shield className="h-5 w-5" aria-hidden="true" /></div>
              <div>
                <h2 id="disable-tools-title" className="text-[18px] font-semibold tracking-[-0.02em] text-gray-950">Disable all {selectedConnection.name} tools?</h2>
                <p id="disable-tools-description" className="mt-1 text-[13px] leading-6 text-gray-600">This immediately blocks every tool across your organization. Agents will stop discovering and calling them, and members will not be able to run them.</p>
              </div>
            </div>
            {policyError ? <div className="mt-4"><DenNotice message={policyError} /></div> : null}
            <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <DenButton variant="secondary" disabled={updatePolicy.isPending} onClick={() => setDisableAllConfirmOpen(false)}>Cancel</DenButton>
              <DenButton
                variant="destructive"
                loading={updatePolicy.isPending}
                onClick={() => void savePolicy({ allDisabled: true, disabledTools: policy.disabledTools }).then((saved) => {
                  if (saved) setDisableAllConfirmOpen(false);
                })}
              >
                Disable all tools
              </DenButton>
            </div>
          </div>
        </div>
      ) : null}
    </DashboardPageTemplate>
  );
}
