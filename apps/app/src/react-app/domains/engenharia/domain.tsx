/** @jsxImportSource react */
import { Navigate } from "react-router";

import { registerDomain, type DomainDefinition } from "../domain-registry";
import {
  DOMAIN_ENGENHARIA_ID,
  isObraModule,
  obrasListRoute,
} from "./obra/obra-routes";
import { buildEngenhariaNavigation } from "./obra/obra-navigation";
import {
  initializeObraRepository,
  listObras,
  useObraRepository,
} from "./obra/obra-repository";
import { ObraListaPage } from "./obra/pages/obra-lista";
import { ObraNovaPage } from "./obra/pages/obra-nova";
import { ObraShellRoute } from "./obra/obra-shell-route";
import { initializeObraEapRepository } from "./obra/obra-eap-repository";

/**
 * Domínio ENGENHARIA.
 * A navegação é fornecida como DADOS (NavigationNode[]) montados a partir do
 * repositório de obras (fonte única). O Core apenas interpreta; a Obra pertence
 * ao domínio, nunca ao Core.
 */
export function buildEngenhariaDomain(): DomainDefinition {
  const obras = listObras();
  return {
    id: DOMAIN_ENGENHARIA_ID,
    label: "Engenharia",
    homeRoute: obrasListRoute(),
    navigation: buildEngenhariaNavigation(obras),
    renderRoute: (path) => {
      const segments = path.replace(/^\/+/, "").split("/").filter(Boolean);
      if (segments[0] === "obras") {
        const segment = segments[1] ? decodeURIComponent(segments[1]) : "";
        if (!segment) {
          // /obras → lista de obras
          return <ObraListaPage />;
        }
        if (segment === "nova") {
          // /obras/nova → criação
          return <ObraNovaPage />;
        }
        // /obras/:obraId[/:modulo]
        const modulo = isObraModule(segments[2]) ? segments[2] : null;
        return <ObraShellRoute obraId={segment} modulo={modulo} />;
      }
      return <Navigate to={obrasListRoute()} replace />;
    },
  };
}

/** Registra (ou re-registra) o domínio com a navegação atual do repositório. */
export function registerEngenhariaDomain(): void {
  registerDomain(buildEngenhariaDomain());
}

// Inicialização (side-effect no import): hidrata do armazenamento local e
// registra a primeira versão. Mudanças posteriores (ex.: criar obra) re-registram
// o domínio para a sidebar consumir a navegação atualizada ao remontar.
initializeObraRepository();
initializeObraEapRepository();
registerEngenhariaDomain();
useObraRepository.subscribe(() => {
  registerEngenhariaDomain();
});


