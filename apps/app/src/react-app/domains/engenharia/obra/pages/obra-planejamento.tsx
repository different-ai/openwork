/** @jsxImportSource react */
import { useMemo } from "react";

import { PlanningDashboard } from "@/react-app/domains/planejamento/planning-dashboard";
import type { PlanningDashboardData } from "@/react-app/domains/planejamento/planning-types";
import { getEapNodesForObra } from "../obra-eap-repository";
import { obraEapParaPlanningDashboard } from "../obra-planejamento-adapter";
import type { Obra } from "../obra-types";

/**
 * Consumer/Adapter do módulo Planejamento no domínio Engenharia.
 *
 * Responsabilidade: traduzir o contexto do domínio para o contrato genérico
 * `PlanningDashboardData` e delegar à capacidade reutilizável de Planejamento.
 * Nenhum conceito de Obra existe dentro de domains/planejamento.
 *
 * Alimenta a Dashboard com os 81 nós reais da EAP + datas derivadas de
 * planejamento (substituindo o dataset demonstrativo).
 */
export function ObraPlanejamento({ obra }: { obra: Obra }) {
  const data = useMemo<PlanningDashboardData>(() => {
    const nodes = getEapNodesForObra(obra.id);
    return obraEapParaPlanningDashboard(nodes, obra.nome);
  }, [obra]);

  return <PlanningDashboard data={data} />;
}
