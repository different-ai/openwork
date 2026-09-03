// Configuração declarativa de navegação do domínio Engenharia.
// Produz NavigationNode[] (dados) a partir do REPOSITÓRIO de obras (fonte única).
// O Core apenas interpreta/renderiza — sem regras de Engenharia no Core.
import type { NavigationNode } from "../../navigation/navigation-types";
import type { Obra } from "./obra-types";
import { SEED_OBRAS } from "./obra-repository";
import {
  DOMAIN_ENGENHARIA_ID,
  OBRA_FASES,
  OBRA_MODULE_LABEL,
  obraNovaRoute,
  obrasListRoute,
  obraRoute,
} from "./obra-routes";

function moduleNodes(obra: Obra): NavigationNode[] {
  return OBRA_FASES.map((fase) => ({
    id: `domain:${DOMAIN_ENGENHARIA_ID}:obra:${obra.id}:fase:${fase.id}`,
    label: fase.label,
    type: "group",
    children: fase.modules.map((module) => ({
      id: `domain:${DOMAIN_ENGENHARIA_ID}:obra:${obra.id}:${module}`,
      label: OBRA_MODULE_LABEL[module],
      type: "module",
      route: obraRoute(obra.id, module),
    })),
  }));
}

function obraNode(obra: Obra): NavigationNode {
  return {
    id: `domain:${DOMAIN_ENGENHARIA_ID}:obra:${obra.id}`,
    label: obra.nome,
    type: "entity",
    route: obraRoute(obra.id),
    children: moduleNodes(obra),
  };
}

/**
 * Monta a árvore DOMÍNIOS → Engenharia → Obras a partir da lista de obras.
 * Inclui a ação "+ Nova obra". Sem estado estático: as obras vêm dos dados.
 */
export function buildEngenhariaNavigation(
  obras: readonly Obra[] = SEED_OBRAS,
): NavigationNode[] {
  const novaObra: NavigationNode = {
    id: `domain:${DOMAIN_ENGENHARIA_ID}:obras:nova`,
    label: "+ Nova obra",
    type: "entity",
    route: obraNovaRoute(),
  };

  return [
    {
      id: `domain:${DOMAIN_ENGENHARIA_ID}`,
      label: "Engenharia",
      type: "domain",
      route: obrasListRoute(),
      children: [
        {
          id: `domain:${DOMAIN_ENGENHARIA_ID}:obras`,
          label: "Obras",
          type: "group",
          children: [novaObra, ...obras.map(obraNode)],
        },
      ],
    },
  ];
}

