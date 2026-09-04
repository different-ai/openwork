/** @jsxImportSource react */
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { EapTree } from "../obra-eap-tree";
import {
  countEapLeaves,
  deriveEapRows,
  deriveEapSummary,
  getEapForObra,
} from "../obra-eap-repository";
import { KpiBar, type KpiItem } from "../obra-kpi-bar";
import type { Obra } from "../obra-types";

const LINHAS_EAP: Array<{ label: string; value: number }> = [];

/**
 * Página EAP da casca (FASE 06.2-B).
 * Exibe o EAP REAL da obra: árvore navegável (expandir/recolher/selecionar) com
 * WBS, nome, tipo e nível, além do resumo estrutural DERIVADO dos nós reais.
 * O resumo nunca é uma fonte independente de números — vem de deriveEapSummary.
 */
export function ObraEap({ obra }: { obra: Obra }) {
  const [collapsedWbs, setCollapsedWbs] = useState<ReadonlySet<string>>(new Set());
  const [selectedWbs, setSelectedWbs] = useState<string | null>(null);

  const eap = useMemo(() => getEapForObra(obra.id), [obra.id]);
  const nodes = eap?.nodes ?? [];

  const summary = useMemo(() => (nodes.length > 0 ? deriveEapSummary(nodes) : null), [nodes]);
  const leaves = useMemo(() => countEapLeaves(nodes), [nodes]);
  const rows = useMemo(() => deriveEapRows(nodes, collapsedWbs), [nodes, collapsedWbs]);

  const selectedNode = selectedWbs ? nodes.find((node) => node.wbs === selectedWbs) ?? null : null;

  const toggleCollapse = (wbs: string) => {
    setCollapsedWbs((prev) => {
      const next = new Set(prev);
      if (next.has(wbs)) next.delete(wbs);
      else next.add(wbs);
      return next;
    });
  };

  if (!eap || nodes.length === 0) {
    return (
      <Card className="w-full">
        <CardHeader>
          <CardTitle>EAP — Estrutura Analítica do Projeto</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Esta obra ainda não possui EAP definida. A estrutura será criada em
          etapa posterior.
        </CardContent>
      </Card>
    );
  }

  const summaryLines = summary
    ? [
        { label: "Nós nível 1 (disciplinas)", value: summary.raizes },
        { label: "Pacotes nível 2", value: summary.pacotes },
        { label: "Trabalhos nível 3", value: summary.trabalhos },
        { label: "Total de nós", value: summary.total },
        { label: "Folhas", value: leaves },
      ]
    : LINHAS_EAP;

  const kpis: KpiItem[] = summary
    ? [
        { id: "kpi-total", label: "Total de nós", value: summary.total },
        { id: "kpi-disciplinas", label: "Disciplinas", value: summary.raizes },
        { id: "kpi-pacotes", label: "Pacotes", value: summary.pacotes },
        { id: "kpi-trabalhos", label: "Trabalhos", value: summary.trabalhos },
        { id: "kpi-folhas", label: "Folhas", value: leaves },
      ]
    : [];

  return (
    <div className="flex w-full flex-col gap-4">
      <KpiBar items={kpis} />
      <Card>
        <CardHeader>
          <CardTitle>EAP — Estrutura Analítica do Projeto</CardTitle>
          <CardDescription>
            {eap.metadata.obraNome} · versão {eap.metadata.versao} · status{" "}
            {eap.metadata.status}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Status</span>
            <Badge variant="outline">{eap.metadata.status}</Badge>
          </div>
          <div className="flex flex-col gap-2">
            {summaryLines.map((linha) => (
              <div
                key={linha.label}
                className="flex items-center justify-between border-b border-border/60 pb-2 last:border-b-0 last:pb-0"
              >
                <span className="text-muted-foreground">{linha.label}</span>
                <span className="font-medium">{linha.value}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card variant="outline">
        <CardHeader>
          <CardTitle>Árvore da EAP</CardTitle>
          <CardDescription>
            Clique para expandir/recolher e selecionar nós. WBS, nome, tipo e
            nível são preservados da fonte oficial.
          </CardDescription>
        </CardHeader>
        <CardContent className="max-h-[60vh] overflow-auto">
          <EapTree
            rows={rows}
            selectedWbs={selectedWbs}
            onSelect={setSelectedWbs}
            onToggle={toggleCollapse}
          />
        </CardContent>
      </Card>

      {selectedNode ? (
        <Card variant="outline">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span className="font-mono text-sm">{selectedNode.wbs}</span>
              <span>{selectedNode.nome}</span>
            </CardTitle>
            <CardDescription>
              Nível {selectedNode.nivel} · {selectedNode.tipo}
              {selectedNode.pai ? ` · pai ${selectedNode.pai}` : " · raiz"}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            {selectedNode.fundamentacao ? (
              <div>
                <span className="text-muted-foreground">Fundamentação: </span>
                {selectedNode.fundamentacao}
              </div>
            ) : null}
            {selectedNode.condicao ? (
              <div className={cn("rounded-md border px-2 py-1 text-xs", "border-amber-500/40 bg-amber-500/5")}>
                <span className="font-medium">Condição: </span>
                {selectedNode.condicao}
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
