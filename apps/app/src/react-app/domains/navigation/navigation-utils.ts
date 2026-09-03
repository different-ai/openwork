// Helpers puros de navegação hierárquica (Core) — testáveis, sem DOM.
import type { NavigationNode } from "./navigation-types";

/** Ativo quando a rota atual casa com o nó (module: igual; pai: prefixo). */
export function isNodeRouteActive(node: NavigationNode, pathname: string): boolean {
  if (!node.route) return false;
  const route = node.route.replace(/\/+$/, "");
  if (node.type === "module") return pathname === route;
  return pathname === route || pathname.startsWith(`${route}/`);
}

/** Algum descendente (direto ou indireto) está ativo na rota atual. */
export function hasActiveDescendant(node: NavigationNode, pathname: string): boolean {
  if (!node.children?.length) return false;
  return node.children.some(
    (child) => isNodeRouteActive(child, pathname) || hasActiveDescendant(child, pathname),
  );
}

/** O nó (ou um descendente) está ativo — usado para destacar e auto-expandir. */
export function isNodeActive(node: NavigationNode, pathname: string): boolean {
  return isNodeRouteActive(node, pathname) || hasActiveDescendant(node, pathname);
}

/** Achata ids de todos os nós (útil para debug/tests). */
export function collectNodeIds(nodes: NavigationNode[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    out.push(node.id);
    if (node.children?.length) out.push(...collectNodeIds(node.children));
  }
  return out;
}

/**
 * Nível de retorno da navegação de um domínio (Core genérico).
 *  - "internal": existe um nível anterior DENTRO do domínio (ancestral com rota própria).
 *  - "external": o nível atual já é o topo do domínio; voltar = sair da navegação de domínios.
 *  - "none": a rota atual não corresponde a nenhum nó do domínio (sem nível anterior válido).
 */
export type DomainNavigationBackTarget =
  | { kind: "none" }
  | { kind: "internal"; label: string; route: string }
  | { kind: "external" };

function normalizePath(value: string): string {
  const trimmed = value.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/**
 * Caminho da raiz até o nó mais profundo cuja rota "hospeda" a rota atual
 * (casamento exato primeiro; quando não há exato, o prefixo mais profundo).
 * Nós agrupadores sem rota (group) nunca são o nó ativo terminal.
 */
export function findActiveNavigationPath(
  nodes: NavigationNode[],
  pathname: string,
): NavigationNode[] {
  const target = normalizePath(pathname);
  let best: NavigationNode[] = [];

  const visit = (list: NavigationNode[], trail: NavigationNode[]) => {
    for (const node of list) {
      const nextTrail = trail.length === 0 ? [node] : [...trail, node];
      const route = node.route?.replace(/\/+$/, "");
      if (route) {
        const hosts =
          route === target || (target.length > route.length && target.startsWith(`${route}/`));
        if (hosts && nextTrail.length > best.length) best = nextTrail;
      }
      if (node.children?.length) visit(node.children, nextTrail);
    }
  };

  visit(nodes, []);
  return best;
}

/**
 * Determina o nível anterior de uma rota de domínio a partir APENAS da árvore
 * declarativa e da rota atual (sem estado duplicado). Sobe do nó ativo até o
 * ancestral mais próximo que possua rota própria distinta da rota atual:
 *  - módulo/entidade interna → "internal" (rota do ancestral);
 *  - topo do domínio (raiz/home, sem ancestral navegável distinto) → "external";
 *  - rota sem nó correspondente → "none".
 */
export function resolveNavigationUpLevel(
  nodes: NavigationNode[],
  pathname: string,
): DomainNavigationBackTarget {
  const path = findActiveNavigationPath(nodes, pathname);
  if (path.length === 0) return { kind: "none" };

  const activeRoute = normalizePath(path[path.length - 1].route ?? "");
  for (let index = path.length - 2; index >= 0; index -= 1) {
    const ancestor = path[index];
    const ancestorRoute = ancestor.route?.replace(/\/+$/, "");
    if (ancestorRoute && ancestorRoute !== activeRoute) {
      return { kind: "internal", label: ancestor.label, route: ancestorRoute };
    }
  }

  return { kind: "external" };
}
