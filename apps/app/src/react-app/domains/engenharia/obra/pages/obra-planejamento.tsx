/** @jsxImportSource react */
import { useMemo } from "react";

import { PlanningDashboard } from "@/react-app/domains/planejamento/planning-dashboard";
import type { PlanningDashboardData } from "@/react-app/domains/planejamento/planning-types";
import { getEapNodesForObra } from "../obra-eap-repository";
import { getEscopo } from "../obra-escopo-repository";
import { KpiBar, type KpiItem } from "../obra-kpi-bar";
import { obraEapParaPlanningDashboard } from "../obra-planejamento-adapter";
import { dataInicioEfetiva, derivarPlanejamentoCompleto, duracaoTotalDasLinhas } from "../obra-planejamento-data";
import type { Obra } from "../obra-types";

/**
 * Consumer/Adapter do módulo Planejamento no domínio Engenharia.
 *
 * Responsabilidade: traduzir o contexto do domínio para o contrato genérico
 * `PlanningDashboardData` e delegar à capacidade reutilizável de Planejamento.
 * Nenhum conceito de Obra existe dentro de domains/planejamento.
 *
 * Alimenta a Dashboard com os 81 nós reais da EAP + datas derivadas de
 * planejamento (substituindo o dataset demonstrativo). KPIs derivados dos dados
 * reais (FASE 21).
 */
export function ObraPlanejamento({ obra }: { obra: Obra }) {
  const data = useMemo<PlanningDashboardData>(() => {
    const nodes = getEapNodesForObra(obra.id);
    return obraEapParaPlanningDashboard(
      nodes,
      obra.nome,
      getEscopo(obra.id),
      dataInicioEfetiva(obra.dataInicio),
    );
  }, [obra]);

  const kpis = useMemo<KpiItem[]>(() => {
    const nodes = getEapNodesForObra(obra.id);
    const linhas = derivarPlanejamentoCompleto(nodes, getEscopo(obra.id));
    const duracaoTotal = duracaoTotalDasLinhas(linhas);
    const comDuracao = linhas.filter((l) => l.duracao > 0).length;
    const criticos = linhas.filter((l) => l.critico === "CRÍTICO").length;
    const sequenciais = linhas.filter((l) => l.critico === "Sequencial").length;
    return [
      { id: "kpi-duracao", label: "Duração (dias)", value: duracaoTotal },
      { id: "kpi-com-duracao", label: "Com duração", value: comDuracao },
      { id: "kpi-criticos", label: "Críticos", value: criticos, tone: "text-destructive" },
      { id: "kpi-sequenciais", label: "Sequenciais", value: sequenciais },
    ];
  }, [obra.id]);

  return (
    <div className="flex w-full flex-col gap-4">
      <KpiBar items={kpis} />
      <PlanningDashboard data={data} />
    </div>
  );
}
