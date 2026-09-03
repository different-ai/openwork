// Navegação genérica do Core — modelo data-driven.
// O Core não conhece Engenharia/Obra/EAP: apenas nós hierárquicos.
export type NavigationNodeType = "domain" | "entity" | "group" | "module";

export type NavigationNode = {
  /** Identificador estável do nó (usado no estado de expansão). */
  id: string;
  label: string;
  type: NavigationNodeType;
  /** Rota de navegação (clique). Nós agrupadores ("group") podem omitir. */
  route?: string;
  children?: NavigationNode[];
  /** Metadados opcionais do domínio (livre). */
  metadata?: Record<string, unknown>;
};
