/** @jsxImportSource react */
import { useMemo } from "react";
import { useNavigate } from "react-router";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getEapSummaryForObra } from "../obra-eap-repository";
import { KpiBar, type KpiItem } from "../obra-kpi-bar";
import { ObraDashboard, type DashboardWidget } from "../obra-dashboard";
import { obraRoute } from "../obra-routes";
import { statusEfetivo } from "../obra-repository";
import { dataInicioEfetiva, diaParaDataIso } from "../obra-planejamento-data";
import type { Obra, ObraCaracterizacao } from "../obra-types";

const CAMPOS_CARACTERIZACAO: Array<{
  label: string;
  value: (c: ObraCaracterizacao) => string;
}> = [
  { label: "Torres", value: (c) => String(c.torres) },
  { label: "Lajes", value: (c) => String(c.lajes) },
  { label: "Apartamentos por pavimento", value: (c) => String(c.apartamentosPorPavimento) },
  { label: "Subsolos", value: (c) => String(c.subsolos) },
  { label: "Sistema construtivo", value: (c) => c.sistemaConstrutivo },
];

export function ObraVisaoGeral({ obra }: { obra: Obra }) {
  const navigate = useNavigate();
  const eapSummary = useMemo(() => getEapSummaryForObra(obra.id), [obra.id]);

  const kpis: KpiItem[] = useMemo(() => {
    const items: KpiItem[] = [];
    const c = obra.caracterizacao;
    if (c) {
      items.push({
        id: "kpi-torres",
        label: "Torres",
        value: c.torres,
        target: obraRoute(obra.id, "caracterizacao"),
      });
      items.push({
        id: "kpi-lajes",
        label: "Lajes",
        value: c.lajes,
        target: obraRoute(obra.id, "caracterizacao"),
      });
      items.push({
        id: "kpi-apartamentos",
        label: "Aptos/pavimento",
        value: c.apartamentosPorPavimento,
        target: obraRoute(obra.id, "caracterizacao"),
      });
      items.push({
        id: "kpi-subsolos",
        label: "Subsolos",
        value: c.subsolos,
        target: obraRoute(obra.id, "caracterizacao"),
      });
    }
    if (eapSummary) {
      items.push({
        id: "kpi-eap-nos",
        label: "Nós EAP",
        value: eapSummary.total,
        hint: `${eapSummary.raizes} disciplinas`,
        target: obraRoute(obra.id, "eap"),
      });
    }
    return items;
  }, [obra, eapSummary]);

  const widgets: DashboardWidget[] = useMemo(() => {
    const status = statusEfetivo(obra);
    const inicioPlanejamento = diaParaDataIso(0, dataInicioEfetiva(obra.dataInicio));
    return [
      {
        id: "widget-identidade",
        title: obra.nome,
        description: "Identificação e metadados da obra.",
        content: (
          <div className="flex flex-col gap-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Status</span>
              <Badge variant="outline">{status}</Badge>
            </div>
            <div className="flex flex-col gap-1 text-xs text-muted-foreground">
              {obra.dataInicio ? <span>Início (cadastro): {obra.dataInicio}</span> : null}
              {obra.dataFim ? <span>Fim (cadastro): {obra.dataFim}</span> : null}
              {obra.localizacao ? <span>Local: {obra.localizacao}</span> : null}
              {obra.responsavel ? <span>Responsável: {obra.responsavel}</span> : null}
              <span>
                Início do cronograma (derivado): {inicioPlanejamento}
              </span>
            </div>
          </div>
        ),
      },
      {
        id: "widget-caracterizacao",
        title: "Caracterização",
        description: "Informações estruturais da obra (somente dados existentes).",
        content: (
          <div className="flex flex-col gap-2 text-sm">
            {obra.caracterizacao ? (
              CAMPOS_CARACTERIZACAO.map((campo) => (
                <div
                  key={campo.label}
                  className="flex items-center justify-between border-b border-border/60 pb-2 last:border-b-0 last:pb-0"
                >
                  <span className="text-muted-foreground">{campo.label}</span>
                  <span className="font-medium">{campo.value(obra.caracterizacao!)}</span>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">
                Caracterização ainda não preenchida para esta obra.
              </p>
            )}
          </div>
        ),
      },
    ];
  }, [obra]);

  return (
    <div className="flex w-full flex-col gap-4">
      <KpiBar items={kpis} onNavigate={(target) => navigate(target)} />
      <ObraDashboard widgets={widgets} />
    </div>
  );
}
