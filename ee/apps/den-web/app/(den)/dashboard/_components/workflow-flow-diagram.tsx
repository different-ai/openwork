import type { WorkflowGraph, WorkflowGraphNode } from "@openwork/types/workflows";
import { CornerDownLeft, GitBranch, Play, Repeat, Search, Wrench } from "lucide-react";

type FlowRow = { nodes: WorkflowGraphNode[]; parallelGroup: string | null };

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

function badgeStyle(namespace: string): string {
  if (namespace === "slack") return "bg-fuchsia-50 text-fuchsia-700";
  if (namespace === "gmail") return "bg-red-50 text-red-700";
  if (namespace === "den") return "bg-blue-50 text-blue-700";
  if (namespace === "marketplace") return "bg-violet-50 text-violet-700";
  return "bg-gray-100 text-gray-600";
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

function nodeBadge(node: WorkflowGraphNode): string {
  if (node.kind === "tool") return node.namespace;
  if (node.kind === "branch") return "if";
  return node.kind;
}

function FlowNode({ node, graph }: { node: WorkflowGraphNode; graph: WorkflowGraph }) {
  const sourceNodes = new Map(graph.nodes.map((candidate) => [candidate.id, candidate]));
  const dataLabels = graph.edges.flatMap((edge) => {
    if (edge.kind !== "data" || edge.to !== node.id || !edge.label) return [];
    return [sourceNodes.get(edge.from)?.kind === "input" ? edge.label : `uses ${edge.label}`];
  });

  return (
    <div className={`w-full max-w-sm rounded-xl border px-3.5 py-3 shadow-sm ${cardStyle(node.kind)}`} data-node-kind={node.kind}>
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="mt-0.5 rounded-lg border border-current/10 bg-white p-1.5 text-gray-500"><NodeIcon kind={node.kind} /></span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${node.kind === "tool" ? badgeStyle(node.namespace) : badgeStyle(node.kind)}`}>{nodeBadge(node)}</span>
            {node.kind === "tool" && node.assignsTo ? <span className="text-[11px] text-gray-400">→ {node.assignsTo}</span> : null}
          </div>
          {node.kind === "tool"
            ? <p className="mt-1.5 break-words font-mono text-[12px] font-medium text-gray-800">{node.tool || node.namespace}</p>
            : <p className="mt-1.5 break-words text-[12px] font-medium text-gray-800">{node.label}</p>}
          {node.kind === "input" && node.fields.length > 0 ? <div className="mt-2 flex flex-wrap gap-1">{node.fields.map((field) => <span key={field} className="rounded-md bg-white px-1.5 py-0.5 font-mono text-[10px] text-gray-500">{field}</span>)}</div> : null}
          {dataLabels.length > 0 ? <div className="mt-2 flex flex-wrap gap-1">{dataLabels.map((label) => <span key={label} className="rounded-full border border-gray-100 bg-gray-50 px-1.5 py-0.5 font-mono text-[10px] text-gray-500">{label}</span>)}</div> : null}
        </div>
      </div>
    </div>
  );
}

export function WorkflowFlowDiagram({ graph }: { graph: WorkflowGraph }) {
  const rows = graphRows(graph);
  return (
    <div className="mt-4" data-testid="den-workflow-flow-diagram">
      {graph.parseError ? <div className="mb-3 rounded-xl border border-amber-100 bg-amber-50 px-3 py-2 text-[12px] text-amber-700">The saved script could not be fully mapped: {graph.parseError}</div> : null}
      {rows.length === 0 && !graph.parseError ? <p className="text-[12px] text-gray-400">No visual steps were found in this version.</p> : null}
      <div className="flex flex-col items-center">
        {rows.map((row, index) => {
          const rowIds = new Set(row.nodes.map((node) => node.id));
          const edgeLabels = [...new Set(graph.edges.flatMap((edge) => edge.kind === "flow" && rowIds.has(edge.from) && edge.label ? [edge.label] : []))];
          return (
            <div key={row.nodes.map((node) => node.id).join(":")} className="flex w-full flex-col items-center" data-node-ids={row.nodes.map((node) => node.id).join(",")} data-parallel-group={row.parallelGroup ?? undefined}>
              <div className="flex w-full justify-center gap-3">{row.nodes.map((node) => <FlowNode key={node.id} node={node} graph={graph} />)}</div>
              {index < rows.length - 1 ? <div className="flex h-8 flex-col items-center justify-center"><div className="h-5 w-px bg-gray-200" />{edgeLabels.length > 0 ? <div className="flex gap-1">{edgeLabels.map((label) => <span key={label} className="rounded-full bg-gray-100 px-1.5 text-[9px] text-gray-500">{label}</span>)}</div> : null}</div> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
