/**
 * Accessibility-tree-based page snapshot.
 * Produces a text representation with UIDs that can be used for click/fill.
 */

import type { CDPClient } from "./cdp";

export type SnapshotNode = {
  uid: number;
  role: string;
  name: string;
  value?: string;
  backendNodeId: number;
  bounds?: { x: number; y: number; width: number; height: number };
  children?: SnapshotNode[];
};

export type Snapshot = {
  nodes: SnapshotNode[];
  byUid: Map<number, SnapshotNode>;
  text: string;
};

let nextUid = 1;

function walkAXTree(
  axNode: Record<string, unknown>,
  allNodes: Record<string, Record<string, unknown>>,
  byUid: Map<number, SnapshotNode>,
): SnapshotNode | null {
  const role = (axNode.role as Record<string, unknown>)?.value as string ?? "";
  const name = (axNode.name as Record<string, unknown>)?.value as string ?? "";
  const value = (axNode.value as Record<string, unknown>)?.value as string | undefined;
  const backendNodeId = axNode.backendDOMNodeId as number ?? 0;
  const ignored = axNode.ignored as boolean;

  // Skip invisible / ignored nodes with no useful content
  if (ignored && !name) return null;

  const uid = nextUid++;
  const children: SnapshotNode[] = [];

  const childIds = axNode.childIds as string[] ?? [];
  for (const childId of childIds) {
    const childAx = allNodes[childId];
    if (!childAx) continue;
    const childNode = walkAXTree(childAx, allNodes, byUid);
    if (childNode) children.push(childNode);
  }

  // Skip generic containers that have no name and only pass-through children
  if (!name && !value && (role === "generic" || role === "none") && children.length <= 1) {
    return children[0] ?? null;
  }

  const node: SnapshotNode = {
    uid,
    role,
    name,
    ...(value !== undefined ? { value } : {}),
    backendNodeId,
    ...(children.length > 0 ? { children } : {}),
  };
  byUid.set(uid, node);
  return node;
}

function renderTree(nodes: SnapshotNode[], indent = 0): string {
  const lines: string[] = [];
  for (const node of nodes) {
    const pad = "  ".repeat(indent);
    const parts = [`[${node.uid}]`, node.role];
    if (node.name) parts.push(`"${node.name}"`);
    if (node.value) parts.push(`value="${node.value}"`);
    lines.push(`${pad}${parts.join(" ")}`);
    if (node.children) {
      lines.push(renderTree(node.children, indent + 1));
    }
  }
  return lines.join("\n");
}

/**
 * Take an accessibility tree snapshot of the page.
 */
export async function takeSnapshot(client: CDPClient): Promise<Snapshot> {
  nextUid = 1;

  // Get the full accessibility tree
  const result = await client.send("Accessibility.getFullAXTree");
  const axNodes = result.nodes as Array<Record<string, unknown>>;

  if (!axNodes || axNodes.length === 0) {
    return { nodes: [], byUid: new Map(), text: "(empty page)" };
  }

  // Index by nodeId
  const indexed: Record<string, Record<string, unknown>> = {};
  for (const node of axNodes) {
    indexed[node.nodeId as string] = node;
  }

  const byUid = new Map<number, SnapshotNode>();
  const roots: SnapshotNode[] = [];

  // The first node is typically the root
  const rootNode = walkAXTree(axNodes[0], indexed, byUid);
  if (rootNode) roots.push(rootNode);

  const text = renderTree(roots);
  return { nodes: roots, byUid, text };
}

/**
 * Resolve a snapshot UID to a CDP backendNodeId for interaction.
 */
export function resolveUid(snapshot: Snapshot, uid: number): SnapshotNode | undefined {
  return snapshot.byUid.get(uid);
}
