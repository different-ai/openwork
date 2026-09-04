import type { WorkflowGraph, WorkflowGraphNode } from "@openwork/types/workflows";
import { CornerDownLeft, GitBranch, Play, Repeat, Search, Wrench } from "lucide-react";
import {
  describeCondition,
  describeLoop,
  describeReturn,
  describeToolStep,
  humanizeIdentifier,
  serviceTone,
} from "./workflow-plain-language";

type FlowRow = { nodes: WorkflowGraphNode[]; parallelGroup: string | null };
type RunState = "ran" | "failed" | "not_reached" | "neutral";
type WorkflowDiagramRun = {
  toolCalls: { name: string }[];
  status: "succeeded" | "failed";
  errorMessage: string | null;
  finishedAt: string;
};
type BranchLanes = {
  branchId: string;
  yesNodes: WorkflowGraphNode[];
  noNodes: WorkflowGraphNode[];
  convergenceId: string | null;
};

function topologicalNodes(graph: WorkflowGraph): WorkflowGraphNode[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const order = new Map(graph.nodes.map((node, index) => [node.id, index]));
  const indegree = new Map(graph.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const node of graph.nodes) outgoing.set(node.id, []);

  for (const edge of graph.edges) {
    if (edge.kind !== "flow" || !byId.has(edge.from) || !byId.has(edge.to)) continue;
    outgoing.get(edge.from)?.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const ready = graph.nodes.filter((node) => indegree.get(node.id) === 0);
  const ordered: WorkflowGraphNode[] = [];
  while (ready.length > 0) {
    ready.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
    const node = ready.shift();
    if (!node) break;
    ordered.push(node);
    for (const target of outgoing.get(node.id) ?? []) {
      const next = (indegree.get(target) ?? 1) - 1;
      indegree.set(target, next);
      const targetNode = byId.get(target);
      if (next === 0 && targetNode) ready.push(targetNode);
    }
  }
  return ordered.length === graph.nodes.length ? ordered : graph.nodes;
}

function graphRows(graph: WorkflowGraph): FlowRow[] {
  const ordered = topologicalNodes(graph);
  const consumedGroups = new Set<string>();
  const rows: FlowRow[] = [];
  for (const node of ordered) {
    const parallelGroup = node.kind === "tool" ? node.parallelGroup : null;
    if (!parallelGroup) {
      rows.push({ nodes: [node], parallelGroup: null });
      continue;
    }
    if (consumedGroups.has(parallelGroup)) continue;
    consumedGroups.add(parallelGroup);
    rows.push({
      nodes: ordered.filter((candidate) => candidate.kind === "tool" && candidate.parallelGroup === parallelGroup),
      parallelGroup,
    });
  }
  return rows;
}

function flowTargets(graph: WorkflowGraph, nodeId: string): string[] {
  return graph.edges.flatMap((edge) => edge.kind === "flow" && edge.from === nodeId ? [edge.to] : []);
}

function reachableNodeIds(graph: WorkflowGraph, startId: string): Set<string> {
  const reachable = new Set<string>();
  const pending = [startId];
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || reachable.has(current)) continue;
    reachable.add(current);
    pending.push(...flowTargets(graph, current));
  }
  return reachable;
}

function successorChain(graph: WorkflowGraph, startId: string, convergenceId: string | null): WorkflowGraphNode[] | null {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const chain: WorkflowGraphNode[] = [];
  const visited = new Set<string>();
  let currentId: string | null = startId;
  while (currentId && currentId !== convergenceId) {
    if (visited.has(currentId)) return null;
    visited.add(currentId);
    const current = byId.get(currentId);
    if (!current) return null;
    chain.push(current);
    const targets: string[] = [...new Set(flowTargets(graph, currentId))];
    if (targets.length === 0) return convergenceId ? null : chain;
    if (targets.length !== 1) return null;
    currentId = targets[0];
  }
  return currentId === convergenceId ? chain : null;
}

function branchLanes(graph: WorkflowGraph, branch: Extract<WorkflowGraphNode, { kind: "branch" }>): BranchLanes | null {
  const labeledEdges = graph.edges.filter((edge) => edge.kind === "flow" && edge.from === branch.id && edge.label);
  const targets = [...new Set(labeledEdges.map((edge) => edge.to))];
  if (labeledEdges.length < 2 || targets.length !== 2) return null;

  const yesEdge = labeledEdges.find((edge) => /^(yes|true)$/i.test(edge.label ?? "")) ?? labeledEdges[0];
  const noEdge = labeledEdges.find((edge) => edge.to !== yesEdge.to && /^(no|false)$/i.test(edge.label ?? ""))
    ?? labeledEdges.find((edge) => edge.to !== yesEdge.to);
  if (!noEdge) return null;

  const yesReachable = reachableNodeIds(graph, yesEdge.to);
  const noReachable = reachableNodeIds(graph, noEdge.to);
  const convergence = topologicalNodes(graph).find((node) => yesReachable.has(node.id) && noReachable.has(node.id));
  const convergenceId = convergence?.id ?? null;
  const yesNodes = successorChain(graph, yesEdge.to, convergenceId);
  const noNodes = successorChain(graph, noEdge.to, convergenceId);
  if (!yesNodes?.length || !noNodes?.length) return null;
  return { branchId: branch.id, yesNodes, noNodes, convergenceId };
}

function toolPath(node: WorkflowGraphNode): string | null {
  return node.kind === "tool" ? node.scriptPath.replace(/^tools\./, "") : null;
}

function runStates(rows: FlowRow[], run: WorkflowDiagramRun | null | undefined): Map<string, RunState> {
  const states = new Map<string, RunState>();
  if (!run) return states;
  let cursor = 0;
  let lastRanNodeId: string | null = null;
  const markRan = (node: WorkflowGraphNode) => {
    states.set(node.id, "ran");
    lastRanNodeId = node.id;
  };

  for (const row of rows) {
    for (const node of row.nodes) {
      if (node.kind === "input") markRan(node);
      else if (node.kind === "tool") states.set(node.id, "not_reached");
    }

    if (row.parallelGroup) {
      const paths = new Set(row.nodes.flatMap((node) => {
        const path = toolPath(node);
        return path ? [path] : [];
      }));
      const matched = new Set<string>();
      while (cursor < run.toolCalls.length && paths.has(run.toolCalls[cursor].name)) {
        const call = run.toolCalls[cursor];
        const node = row.nodes.find((candidate) => !matched.has(candidate.id) && toolPath(candidate) === call.name);
        if (node) {
          matched.add(node.id);
          markRan(node);
        }
        cursor += 1;
      }
      continue;
    }

    for (const node of row.nodes) {
      const path = toolPath(node);
      if (path && run.toolCalls[cursor]?.name === path) {
        markRan(node);
        cursor += 1;
      }
    }
  }

  if (run.status === "failed" && lastRanNodeId) states.set(lastRanNodeId, "failed");
  return states;
}

function cardStyle(kind: WorkflowGraphNode["kind"]): string {
  if (kind === "branch") return "border-amber-200 bg-amber-50/40";
  if (kind === "return") return "border-emerald-200 bg-emerald-50/40";
  if (kind === "input") return "border-blue-200 bg-blue-50/40";
  return "border-gray-200 bg-white";
}

function NodeIcon({ kind }: { kind: WorkflowGraphNode["kind"] }) {
  const className = "h-3.5 w-3.5";
  if (kind === "input") return <Play className={className} />;
  if (kind === "tool") return <Wrench className={className} />;
  if (kind === "search") return <Search className={className} />;
  if (kind === "branch") return <GitBranch className={className} />;
  if (kind === "loop") return <Repeat className={className} />;
  return <CornerDownLeft className={className} />;
}

function sourceLabel(node: WorkflowGraphNode): string {
  if (node.kind === "branch") return "Decision";
  if (node.kind === "tool") return describeToolStep(node).title;
  if (node.kind === "return") return "Finish";
  if (node.kind === "input") return "Start";
  return humanizeIdentifier(node.label);
}

function toolTone(node: Extract<WorkflowGraphNode, { kind: "tool" }>): string {
  const service = describeToolStep(node).service;
  if (service === "Gmail") return serviceTone("gmail");
  if (service === "Google Calendar") return serviceTone("calendar");
  if (service === "Google Drive") return serviceTone("drive");
  if (service === "Google Docs") return serviceTone("docs");
  if (service === "Google Sheets") return serviceTone("sheets");
  return serviceTone(node.namespace);
}

function nodeBadge(node: WorkflowGraphNode): { label: string; className: string } {
  if (node.kind === "tool") return { label: describeToolStep(node).service, className: toolTone(node) };
  if (node.kind === "branch") return { label: "Decision", className: "bg-amber-100 text-amber-700" };
  if (node.kind === "loop") return { label: "Repeat", className: "bg-violet-50 text-violet-700" };
  if (node.kind === "return") return { label: "Finish", className: "bg-emerald-100 text-emerald-700" };
  if (node.kind === "input") return { label: "Start", className: "bg-blue-100 text-blue-700" };
  return { label: "Search", className: "bg-gray-100 text-gray-600" };
}

function nodeTitle(node: WorkflowGraphNode, technical: boolean): string {
  if (node.kind === "tool") return describeToolStep(node).title;
  if (node.kind === "branch") {
    const description = describeCondition(node.label);
    return description.technical && !technical ? "Check a condition" : description.text;
  }
  if (node.kind === "loop") return describeLoop(node.label);
  if (node.kind === "return") return describeReturn(node.label);
  if (node.kind === "input") return "Start";
  return humanizeIdentifier(node.label);
}

function inputFieldLabel(field: string): string {
  return humanizeIdentifier(field.replace(/Iso$/, ""));
}

function inputValue(value: unknown): string | null {
  if (value === undefined) return null;
  if (value === null || value === "") return "Empty";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  return "Provided";
}

function FlowNode({
  node,
  graph,
  runState,
  errorMessage,
  stepNumber,
  technical,
  inputValues,
}: {
  node: WorkflowGraphNode;
  graph: WorkflowGraph;
  runState: RunState;
  errorMessage: string | null;
  stepNumber: number;
  technical: boolean;
  inputValues: Record<string, unknown> | undefined;
}) {
  const sourceNodes = new Map(graph.nodes.map((candidate) => [candidate.id, candidate]));
  const dataLabels = graph.edges.flatMap((edge) => {
    if (edge.kind !== "data" || edge.to !== node.id || !edge.label) return [];
    const label = humanizeIdentifier(edge.label.split(".").at(-1) ?? edge.label);
    return [{ plain: sourceNodes.get(edge.from)?.kind === "input" ? label : `Uses ${label}`, raw: edge.label }];
  });
  const badge = nodeBadge(node);

  return (
    <div className="w-full max-w-sm">
      <div className={`rounded-xl border px-3.5 py-3 shadow-sm ${runState === "failed" ? "border-red-300 bg-red-50/30" : cardStyle(node.kind)} ${runState === "not_reached" ? "opacity-50" : ""}`} data-node-id={node.id} data-node-kind={node.kind} data-run-state={runState === "neutral" ? undefined : runState} data-terminal={node.kind === "return" ? "true" : undefined}>
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-gray-200 bg-white text-[10px] font-semibold text-gray-600" data-step-number={stepNumber}>{stepNumber}</span>
          <span className="mt-0.5 rounded-lg border border-current/10 bg-white p-1.5 text-gray-500"><NodeIcon kind={node.kind} /></span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${badge.className}`}>{badge.label}</span>
              {runState === "ran" ? <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />This run: ✓ completed</span> : null}
              {runState === "failed" ? <span className="rounded-full bg-red-50 px-1.5 py-0.5 text-[10px] text-red-700">This run: ✗ stopped here</span> : null}
              {runState === "not_reached" ? <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">This run: skipped</span> : null}
            </div>
            <p className="mt-1.5 break-words text-[12px] font-medium text-gray-800">{nodeTitle(node, technical)}</p>
            {node.kind === "tool" && node.assignsTo ? <p className="mt-1 text-[11px] text-gray-500">Saves the result as <strong className="font-semibold">{humanizeIdentifier(node.assignsTo).toLowerCase()}</strong></p> : null}
            {node.kind === "input" && node.fields.length > 0 ? <div className="mt-2"><p className="mb-1 text-[10px] text-gray-400">Runs with:</p><div className="flex flex-wrap gap-1">{node.fields.map((field) => {
              const value = inputValue(inputValues?.[field]);
              return <span key={field} className="rounded-md bg-white px-1.5 py-0.5 text-[10px] text-gray-600">{inputFieldLabel(field)}{value ? ` · ${value}` : ""}</span>;
            })}</div></div> : null}
            {dataLabels.length > 0 ? <div className="mt-2 flex flex-wrap gap-1">{dataLabels.map((label) => <span key={label.raw} className="rounded-full border border-gray-100 bg-gray-50 px-1.5 py-0.5 text-[10px] text-gray-500">{label.plain}</span>)}</div> : null}
            {technical ? <div className="mt-2 space-y-1 break-all font-mono text-[10px] text-gray-400">
              {node.kind === "tool" ? <p>{node.scriptPath}</p> : null}
              {node.kind === "branch" ? <p>{node.label}</p> : null}
              {node.kind === "input" && node.fields.length > 0 ? <p>Fields: {node.fields.join(", ")}</p> : null}
              {dataLabels.map((label) => <p key={`technical:${label.raw}`}>Input: {label.raw}</p>)}
            </div> : null}
          </div>
        </div>
      </div>
      {runState === "failed" && errorMessage ? <p className="mt-1 rounded-lg bg-red-50 px-2 py-1 text-[10px] text-red-700">{errorMessage.slice(0, 200)}</p> : null}
    </div>
  );
}

function FlowConnector() {
  return <div className="flex h-8 flex-col items-center justify-center" data-connector="flow"><div className="h-5 w-px bg-gray-200" /></div>;
}

function LaneColumn({
  label,
  nodes,
  graph,
  states,
  run,
  stepNumbers,
  technical,
  inputValues,
}: {
  label: "yes" | "no";
  nodes: WorkflowGraphNode[];
  graph: WorkflowGraph;
  states: Map<string, RunState>;
  run: WorkflowDiagramRun | null | undefined;
  stepNumbers: Map<string, number>;
  technical: boolean;
  inputValues: Record<string, unknown> | undefined;
}) {
  return <div className="flex min-w-0 flex-1 flex-col items-center" data-lane={label}>
    <p className="text-[9px] font-semibold uppercase tracking-wider text-gray-400">{label === "yes" ? "Yes" : "No"}</p>
    {nodes.map((node) => <div key={node.id} className="flex w-full flex-col items-center"><FlowConnector /><FlowNode node={node} graph={graph} runState={states.get(node.id) ?? "neutral"} errorMessage={run?.errorMessage ?? null} stepNumber={stepNumbers.get(node.id) ?? 0} technical={technical} inputValues={inputValues} /></div>)}
  </div>;
}

function runDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

export function WorkflowFlowDiagram({
  graph,
  run,
  technical = false,
  inputValues,
}: {
  graph: WorkflowGraph;
  run?: WorkflowDiagramRun | null;
  technical?: boolean;
  inputValues?: Record<string, unknown>;
}) {
  const allRows = graphRows(graph);
  const states = runStates(allRows, run);
  const ordered = topologicalNodes(graph);
  const stepNumbers = new Map(ordered.map((node, index) => [node.id, index + 1]));
  const layouts = new Map<string, BranchLanes>();
  const laneNodeIds = new Set<string>();
  for (const node of ordered) {
    if (node.kind !== "branch") continue;
    const layout = branchLanes(graph, node);
    if (!layout) continue;
    const layoutIds = [...layout.yesNodes, ...layout.noNodes].map((laneNode) => laneNode.id);
    if (layoutIds.some((id) => laneNodeIds.has(id))) continue;
    layouts.set(node.id, layout);
    layoutIds.forEach((id) => laneNodeIds.add(id));
  }
  const rows = allRows.flatMap((row) => {
    const nodes = row.nodes.filter((node) => !laneNodeIds.has(node.id));
    return nodes.length > 0 ? [{ ...row, nodes }] : [];
  });

  return (
    <div className="mt-4" data-testid="den-workflow-flow-diagram">
      {run ? <p className="mb-3 text-[11px] text-gray-500">Last run: {runDate(run.finishedAt)} · {run.status === "succeeded" ? "Succeeded" : "Failed"}</p> : null}
      {graph.parseError ? <div className="mb-3 rounded-xl border border-amber-100 bg-amber-50 px-3 py-2 text-[12px] text-amber-700">We couldn&apos;t map every step of this version. The code still runs; only the picture is incomplete.{technical ? <p className="mt-1 font-mono text-[10px]">{graph.parseError}</p> : null}</div> : null}
      {rows.length === 0 && !graph.parseError ? <p className="text-[12px] text-gray-400">No steps are available to show yet.</p> : null}
      <div className="flex flex-col items-center">
        {rows.map((row, index) => {
          const rowIds = new Set(row.nodes.map((node) => node.id));
          const previousRowIds = new Set(rows[index - 1]?.nodes.map((node) => node.id) ?? []);
          const sourceNodes = new Map(graph.nodes.map((node) => [node.id, node]));
          const incoming = graph.edges.filter((edge) => edge.kind === "flow" && rowIds.has(edge.to));
          const labeledIncoming = [...new Map(incoming.flatMap((edge) => edge.label ? [[`${edge.from}:${edge.to}:${edge.label}`, edge]] : [])).values()];
          const layout = row.nodes.length === 1 ? layouts.get(row.nodes[0].id) : undefined;
          return (
            <div key={row.nodes.map((node) => node.id).join(":")} className="flex w-full flex-col items-center" data-node-ids={row.nodes.map((node) => node.id).join(",")} data-parallel-group={row.parallelGroup ?? undefined}>
              {index > 0 ? incoming.length > 0 ? <div className="flex h-8 flex-col items-center justify-center" data-connector="flow"><div className="h-5 w-px bg-gray-200" />{labeledIncoming.length > 0 ? <div className="flex gap-1">{labeledIncoming.map((edge) => {
                const source = sourceNodes.get(edge.from);
                const label = `${edge.label}${!previousRowIds.has(edge.from) && source ? ` · from ${sourceLabel(source)}` : ""}`;
                return <span key={`${edge.from}:${edge.to}:${edge.label}`} className="rounded-full bg-gray-100 px-1.5 text-[9px] text-gray-500">{label}</span>;
              })}</div> : null}</div> : <div className="h-4" /> : null}
              {row.parallelGroup ? <p className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-gray-400">At the same time</p> : null}
              <div className="flex w-full justify-center gap-3">{row.nodes.map((node) => <FlowNode key={node.id} node={node} graph={graph} runState={states.get(node.id) ?? "neutral"} errorMessage={run?.errorMessage ?? null} stepNumber={stepNumbers.get(node.id) ?? 0} technical={technical} inputValues={inputValues} />)}</div>
              {layout ? <div className="mt-1 flex w-full max-w-3xl gap-4 rounded-xl bg-gray-50/60 px-3 pb-3 pt-2"><LaneColumn label="yes" nodes={layout.yesNodes} graph={graph} states={states} run={run} stepNumbers={stepNumbers} technical={technical} inputValues={inputValues} /><LaneColumn label="no" nodes={layout.noNodes} graph={graph} states={states} run={run} stepNumbers={stepNumbers} technical={technical} inputValues={inputValues} /></div> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
