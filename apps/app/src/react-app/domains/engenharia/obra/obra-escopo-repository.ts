// Domínio Engenharia — repositório de Escopo/Serviço por obra (P0b).
//
// Desacopla o escopo de quantidades/produtividades por WBS (antes o mapa global
// `OBRA_SCOPE_REF`) para um registro por `obraId`. A obra-modelo é semeada com
// os MESMOS dados de `OBRA_SCOPE_REF` (paridade preservada); outras obras
// começam sem escopo (resolvem a "sem escopo" → duração 0).
//
// Direção D3 (P1): este registro evolui para o cadastro de Serviço
// (EAP × Frente × Local). Aqui mantemos apenas o registro de quantidades/
// produtividades por obra, sem criar a entidade Serviço completa.
import { OBRA_MODELO_EAP_ID } from "./obra-eap-data";
import { OBRA_SCOPE_REF, type ObraEapScopeRef } from "./obra-planejamento-data";

/** Escopo de um WBS dentro de uma obra (quantidade/produtividade). */
export type ObraEscopo = ObraEapScopeRef & {
  obraId: string;
  wbs: string;
};

/** Mapa de escopo por obra: obraId → (wbs → ObraEscopo). */
type EscopoStore = Record<string, Record<string, ObraEscopo>>;

/** Seed da obra-modelo: migra `OBRA_SCOPE_REF` para o registro por obra. */
function seedObraModelo(): Record<string, ObraEscopo> {
  const mapa: Record<string, ObraEscopo> = {};
  for (const [wbs, ref] of Object.entries(OBRA_SCOPE_REF)) {
    mapa[wbs] = { obraId: OBRA_MODELO_EAP_ID, wbs, ...ref };
  }
  return mapa;
}

const escopoStore: EscopoStore = {
  [OBRA_MODELO_EAP_ID]: seedObraModelo(),
};

/** Retorna o escopo (wbs → ObraEscopo) de uma obra; `{}` se não houver. */
export function getEscopo(obraId: string): Record<string, ObraEscopo> {
  return escopoStore[obraId] ?? {};
}

/** Define/substitui o escopo de uma obra. */
export function setEscopo(obraId: string, mapa: Record<string, ObraEscopo>): void {
  escopoStore[obraId] = mapa;
}
