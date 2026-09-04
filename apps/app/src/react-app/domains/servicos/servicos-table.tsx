/** @jsxImportSource react */
import { useMemo } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { deriveServicosSummary } from "./servicos-data";
import { ServicosHelp } from "./servicos-help";
import type { ServicosData } from "./servicos-types";

/**
 * Tabela de Serviços — capacidade genérica (FASE 21).
 * Consome QUALQUER ServicosData fornecido por um adapter do domínio. KPIs
 * derivados dos dados reais. Preparada para a FASE 22 (orçamento, medição).
 */
export function ServicosTable({ data }: { data: ServicosData }) {
  const summary = useMemo(() => deriveServicosSummary(data), [data]);

  if (data.items.length === 0) {
    return (
      <Card className="w-full">
        <CardHeader>
          <CardTitle>{data.title}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Nenhum serviço para exibir.
        </CardContent>
      </Card>
    );
  }

  const kpis = [
    { id: "kpi-total", label: "Total", value: summary.total },
    { id: "kpi-com-duracao", label: "Com duração", value: summary.comDuracao },
    { id: "kpi-criticos", label: "Críticos", value: summary.criticos, tone: "text-destructive" },
    { id: "kpi-sequenciais", label: "Sequenciais", value: summary.sequenciais },
  ];

  return (
    <div className="flex w-full flex-col gap-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>{data.title}</CardTitle>
            {data.subtitle ? (
              <CardDescription>{data.subtitle}</CardDescription>
            ) : null}
          </div>
          <ServicosHelp />
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div
            data-kpi-bar
            className="grid grid-cols-2 gap-2 lg:grid-cols-4"
            aria-label="Indicadores"
          >
            {kpis.map((kpi) => (
              <Card key={kpi.id} className="min-w-0">
                <CardContent className="flex flex-col gap-0.5 py-3">
                  <span className="truncate text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {kpi.label}
                  </span>
                  <span
                    className={`text-2xl font-bold tabular-nums ${kpi.tone ?? ""}`}
                    data-kpi={kpi.id}
                  >
                    {kpi.value}
                  </span>
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="max-h-[70vh] overflow-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-1.5 pr-2 font-medium">WBS</th>
                  <th className="py-1.5 pr-2 font-medium">Serviço</th>
                  <th className="py-1.5 pr-2 font-medium">Duração</th>
                  <th className="py-1.5 pr-2 font-medium">Início</th>
                  <th className="py-1.5 pr-2 font-medium">Fim</th>
                  <th className="py-1.5 font-medium">Crítico</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => {
                  const temData = item.duracao > 0;
                  return (
                    <tr key={item.id} className="border-b border-border/40">
                      <td className="py-1.5 pr-2 font-mono text-xs text-muted-foreground">
                        {item.codigo}
                      </td>
                      <td className="py-1.5 pr-2 font-medium">{item.nome}</td>
                      <td className="py-1.5 pr-2 tabular-nums">
                        {item.duracao > 0 ? `${item.duracao} d` : "—"}
                      </td>
                      <td className="py-1.5 pr-2 tabular-nums">
                        {temData ? item.inicio : "—"}
                      </td>
                      <td className="py-1.5 pr-2 tabular-nums">
                        {temData ? item.fim : "—"}
                      </td>
                      <td className="py-1.5">
                        {item.status === "CRÍTICO" ? (
                          <Badge variant="destructive">Crítico</Badge>
                        ) : item.status === "Sequencial" ? (
                          <Badge variant="outline">Sequencial</Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
