/** @jsxImportSource react */
import { useMemo } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { LobGrade } from "@/react-app/domains/linha-de-balanco/lob-grade";
import { getEapNodesForObra } from "../obra-eap-repository";
import { getEscopo } from "../obra-escopo-repository";
import { derivarGradeLob } from "../obra-lob-data";
import { dataInicioEfetiva } from "../obra-planejamento-data";
import { KpiBar, type KpiItem } from "../obra-kpi-bar";
import type { Obra } from "../obra-types";

/**
 * Página Linha de Balanço da casca (FASE 20.x / FASE 21).
 * Adapter: deriva a grade LOB dos nós reais da EAP + planejamento e delega a
 * renderização à capacidade genérica `LobGrade`. KPIs derivados dos dados reais.
 */
export function ObraLobGrade({ obra }: { obra: Obra }) {
  const nodes = useMemo(() => getEapNodesForObra(obra.id), [obra.id]);
  const { semanas, linhas } = useMemo(
    () => derivarGradeLob(nodes, getEscopo(obra.id), dataInicioEfetiva(obra.dataInicio)),
    [nodes, obra.dataInicio, obra.id],
  );

  const kpis = useMemo<KpiItem[]>(() => {
    const criticos = linhas.filter((l) => l.critico === "CRÍTICO").length;
    return [
      { id: "kpi-semanas", label: "Semanas", value: semanas.length },
      { id: "kpi-servicos", label: "Serviços", value: linhas.length },
      { id: "kpi-criticos", label: "Críticos", value: criticos, tone: "text-destructive" },
      {
        id: "kpi-inicio",
        label: "Início",
        value: semanas[0]?.inicio ?? "—",
        hint: "Data de início",
      },
      {
        id: "kpi-fim",
        label: "Fim",
        value: semanas[semanas.length - 1]?.fim ?? "—",
        hint: "Data de fim",
      },
    ];
  }, [semanas, linhas]);

  if (linhas.length === 0) {
    return (
      <Card className="w-full">
        <CardContent className="text-sm text-muted-foreground">
          Esta obra ainda não possui EAP definida.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex w-full flex-col gap-4">
      <KpiBar items={kpis} />
      <LobGrade data={{ semanas, linhas }} />
    </div>
  );
}
