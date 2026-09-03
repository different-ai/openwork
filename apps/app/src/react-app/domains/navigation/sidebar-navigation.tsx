/** @jsxImportSource react */
import * as React from "react";
import { ChevronRight } from "lucide-react";
import { useLocation, useNavigate } from "react-router";
import { cn } from "@/lib/utils";
import { useNavigationState } from "./navigation-state";
import type { NavigationNode, NavigationNodeType } from "./navigation-types";
import { isNodeActive, hasActiveDescendant } from "./navigation-utils";

/**
 * RENDERER GENÉRICO da árvore de navegação do Core.
 *
 * Fluxo: Navigation Data (NavigationNode[]) → SidebarNavigationList (recursivo) → DOM nativo
 * da sidebar (tokens de sidebar do OpenWork). NÃO conhece Engenharia/Obra/EAP.
 *
 * FASE 04.2-D (correção VISUAL): a hierarquia é reforçada de forma GENÉRICA —
 *  - tipografia/ênfase por tipo de nó (domain / group / entity / module);
 *  - indentação com guia vertical crescente por profundidade;
 *  - item ativo sempre destacado, independente do tipo.
 * Nenhuma regra de domínio foi adicionada; a diferenciação vem da estrutura de dados.
 */

const NAV_ROW_CLASS =
  "group/navrow flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-sidebar-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40";

/** Estilo dos nós INATIVOS por tipo (propriedades genéricas de apresentação). */
const TYPED_TEXT_CLASS: Record<NavigationNodeType, string> = {
  domain: "text-[13px] font-semibold text-sidebar-foreground",
  group: "text-[11px] font-semibold uppercase tracking-[0.14em] text-sidebar-foreground/70",
  entity: "text-[13px] font-medium text-sidebar-foreground/90",
  module: "text-[13px] text-sidebar-foreground/80",
};

/** Item ativo: destaque uniforme em qualquer nível. */
const ACTIVE_TEXT_CLASS = "font-semibold text-foreground";

export function SidebarNavigationList({
  nodes,
  depth = 0,
}: {
  nodes: NavigationNode[];
  depth?: number;
}) {
  return (
    <div className="flex flex-col gap-0.5" data-nav-depth={depth}>
      {nodes.map((node) => (
        <SidebarNavNode key={node.id} node={node} depth={depth} />
      ))}
    </div>
  );
}

function SidebarNavNode({ node, depth }: { node: NavigationNode; depth: number }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const expandedNodeIds = useNavigationState((s) => s.expandedNodeIds);
  const toggleNode = useNavigationState((s) => s.toggleNode);
  const expandNode = useNavigationState((s) => s.expandNode);

  const hasChildren = Boolean(node.children?.length);
  const active = isNodeActive(node, pathname);
  const expanded = expandedNodeIds.includes(node.id);

  // Auto-expande nós com descendente ativo (ex.: rota recarregada /obra/.../eap).
  React.useEffect(() => {
    if (hasChildren && hasActiveDescendant(node, pathname) && !expanded) {
      expandNode(node.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, hasChildren, node.id]);

  const handleClick = () => {
    if (hasChildren) {
      toggleNode(node.id);
      return;
    }
    if (node.route) navigate(node.route);
  };

  const textClass = active ? ACTIVE_TEXT_CLASS : TYPED_TEXT_CLASS[node.type];

  const rowClassName = cn(
    NAV_ROW_CLASS,
    textClass,
    // FASE 04.2-D: nós agrupadores/domínio ganham leve separação superior quando
    // aninhados (diferencia visualmente coletivo/entidade sem tocar nos dados).
    depth === 0 && "mt-1 first:mt-0",
    active && "bg-sidebar-accent",
  );

  return (
    <div data-nav-node={node.id} data-nav-type={node.type}>
      <button
        type="button"
        aria-expanded={hasChildren ? expanded : undefined}
        className={rowClassName}
        onClick={handleClick}
        title={node.route ? node.label : `${node.label} (grupo)`}
      >
        <span className="min-w-0 flex-1 truncate text-left">{node.label}</span>
        {hasChildren ? (
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
              expanded && "rotate-90",
            )}
          />
        ) : null}
      </button>

      {hasChildren && expanded ? (
        <div className="ms-2.5 border-l-2 border-sidebar-border/60 ps-2.5">
          <SidebarNavigationList nodes={node.children ?? []} depth={depth + 1} />
        </div>
      ) : null}
    </div>
  );
}

