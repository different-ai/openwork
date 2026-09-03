/** @jsxImportSource react */
import { ChevronLeft } from "lucide-react";
import { useLocation, useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import type { NavigationNode } from "./navigation/navigation-types";
import { resolveNavigationUpLevel } from "./navigation/navigation-utils";

/**
 * Ação de "Voltar ao nível anterior" da navegação de domínios (Core genérico).
 *
 * Aparece apenas dentro do conteúdo de um domínio (`/dominios/:domainId[...]`)
 * e quando existe um nível anterior válido, derivado SOMENTE da rota atual
 * (useLocation) + árvore declarativa (NavigationNode[]) — sem estado duplicado:
 *  - nível interno (ex.: módulo dentro de uma entidade) → volta ao ancestral
 *    imediatamente acima com rota própria (rótulo dinâmico);
 *  - topo do domínio (home/raiz) → volta para fora da navegação de domínios
 *    (exitRoute, por padrão a área principal `/session`);
 *  - rota sem correspondência na árvore → não renderiza nada.
 *
 * NÃO conhece Engenharia/Obra/EAP — funciona para qualquer domínio futuro.
 */

const EXTERNAL_LABEL = "Voltar para a visão principal";

export type DomainBackButtonProps = {
  /** Árvore de navegação do domínio atual (dados declarativos). */
  navigation: NavigationNode[];
  /** Rota usada quando o nível anterior é externo ao domínio. */
  exitRoute?: string;
};

export function DomainBackButton({
  navigation,
  exitRoute = "/session",
}: DomainBackButtonProps) {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const target = resolveNavigationUpLevel(navigation, pathname);
  if (target.kind === "none") return null;

  const isInternal = target.kind === "internal";
  const accessibleLabel = isInternal
    ? `Voltar para ${target.label}`
    : EXTERNAL_LABEL;
  const destination = isInternal ? target.route : exitRoute;

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-domain-back-button
      data-domain-back-target={isInternal ? "internal" : "external"}
      className="group/back h-7 w-fit gap-1 px-1.5 text-muted-foreground hover:text-foreground"
      onClick={() => navigate(destination)}
      aria-label={accessibleLabel}
      title={accessibleLabel}
    >
      <ChevronLeft
        className="size-4 transition-transform duration-150 group-hover/back:-translate-x-0.5"
        aria-hidden="true"
      />
      <span>Voltar</span>
    </Button>
  );
}
