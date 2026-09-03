// Domínio Engenharia — referência reutilizável de EAP (EapReference).
//
// A Obra Modelo EAP é a PRIMEIRA referência da biblioteca de EAPs modelo.
// A referência NÃO substitui a EAP operacional da Obra: ela aponta para a
// origem (origemObraId) e expõe os nós por identidade, evitando duplicação.
//
// Futuramente, Skills/Agents/MCPs poderão selecionar, analisar e adaptar estas
// referências para criar EAPs de novas obras. A Obra Modelo NÃO é um template
// universal nem fonte operacional das outras obras.
import type { EapReference, ObraEapNode } from "./obra-eap-types";
import { getEapNodesForObra } from "./obra-eap-repository";

/** Primeira referência de EAP: EAP Residencial Completo (Obra Modelo EAP). */
export const REF_EAP_RES_001: EapReference = {
  id: "REF-EAP-RES-001",
  nome: "EAP Residencial Completo",
  descricao:
    "EAP completa de um edifício residencial de concreto armado (1 torre, 14 lajes, pilotis, sobresolo, 1 unidade por pavimento, sem subsolo), com 81 nós distribuídos em 10 disciplinas, 24 pacotes e 47 trabalhos.",
  origem: "Obra Modelo EAP",
  versaoOrigem: "FASE-19.5",
  origemObraId: "OBRA-MODELO-EAP-001",
  caracterizacao: {
    torres: 1,
    lajes: 14,
    pilotis: true,
    sobresolo: true,
    unidades_por_pavimento: 1,
    subsolos: 0,
    sistema_construtivo: "concreto_armado",
    cobertura_prevista: true,
  },
  principios: [
    "regra_100_porcento",
    "exclusividade_mutua",
    "orientacao_a_entregaveis",
    "decomposicao_progressiva",
    "work_packages",
    "rastreabilidade",
    "separacao_eap_do_cronograma",
  ],
  regrasObservadas: [
    "A estrutura e laje de cobertura (5.1.1) é alocada na disciplina 5 (Cobertura e Impermeabilização), não na disciplina 3 (Superestrutura).",
  ],
  metadados: {
    status: "PROPOSTA",
    quantidade_nos: 81,
    distribuicao: { DISCIPLINA: 10, PACOTE: 24, TRABALHO: 47 },
  },
};

/** Catálogo de referências de EAP disponíveis (biblioteca). */
export const EAP_REFERENCES: EapReference[] = [REF_EAP_RES_001];

/** Resolve os nós de uma referência a partir da EAP operacional da origem. */
export function resolveReferenceNodes(reference: EapReference): ObraEapNode[] {
  return getEapNodesForObra(reference.origemObraId);
}

/** Busca uma referência por id. */
export function findEapReference(id: string): EapReference | undefined {
  return EAP_REFERENCES.find((reference) => reference.id === id);
}
