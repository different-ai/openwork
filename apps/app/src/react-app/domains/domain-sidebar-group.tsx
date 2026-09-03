/** @jsxImportSource react */
import {
  SidebarGroup,
  SidebarGroupContent,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import {
  SIDEBAR_SECTION_LABEL,
  SIDEBAR_SECTION_LANE,
} from "@/react-app/domains/session/sidebar/sidebar-lanes";
import { listDomains } from "./domain-bootstrap";
import { SidebarNavigationList } from "./navigation/sidebar-navigation";

/**
 * Seção "DOMÍNIOS" da sidebar (Core genérico).
 * Para cada domínio registrado, renderiza a árvore declarativa (navigation: NavigationNode[])
 * usando o renderer genérico de navegação. Nenhum conceito de Engenharia/Obra existe aqui.
 */
export function DomainsSidebarGroup() {
  const domains = listDomains();
  if (domains.length === 0) return null;

  return (
    <SidebarGroup>
      <div className={cn("flex h-6 items-center", SIDEBAR_SECTION_LANE)}>
        <span className={SIDEBAR_SECTION_LABEL}>DOMÍNIOS</span>
      </div>
      <SidebarGroupContent>
        {domains.map((domain) => (
          <div key={domain.id} data-domain-id={domain.id} className="mb-1 last:mb-0">
            <SidebarNavigationList nodes={domain.navigation} depth={0} />
          </div>
        ))}
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

