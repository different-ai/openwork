/** @jsxImportSource react */
import { useMemo } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getEapNodesForObra } from "../obra-eap-repository";
import { getEscopo } from "../obra-escopo-repository";
import { dataInicioEfetiva, derivarPlanejamentoCompleto, diaParaDataIso } from "../obra-planejamento-data";
import type { Obra } from "../obra-types";

/**
 * Página Produção da casca (FASE 20.x).
 *
 * Acompanhamento planejado × realizado. Para a obra real, a produção é derivada
 * do cronograma da EAP real (81 nós): cada TRABALHO com duração mostra a
 * quantidade planejada e o ritmo. Os dados de produção REAL (quantidade
 * executada) ainda não existem para a obra real — ficam marcados como pendentes.
 */
export function ObraProducao({ obra }: { obra: Obra }) {
  const nodes = useMemo(() => getEapNodesForObra(obra.id), [obra.id]);
  const escopo = useMemo(() => getEscopo(obra.id), [obra.id]);
  const startDate = useMemo(() => dataInicioEfetiva(obra.dataInicio), [obra.dataInicio]);
  const linhas = useMemo(
    () => derivarPlanejamentoCompleto(nodes, escopo, startDate),
    [nodes, escopo, startDate],
  );

  const producao = useMemo(
    () => linhas.filter((l) => l.node.tipo === "TRABALHO" && l.duracao > 0),
    [linhas],
  );

  if (producao.length === 0) {
    return (
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Produção</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Esta obra ainda não possui EAP definida.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex w-full flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Produção</CardTitle>
          <CardDescription>
            {producao.length} trabalhos com duração do cronograma da EAP real.
            Quantidade planejada e ritmo derivados; produção real (executada)
            pendente de registro.
          </CardDescription>
        </CardHeader>
        <CardContent className="max-h-[70vh] overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-1.5 pr-2 font-medium">WBS</th>
                <th className="py-1.5 pr-2 font-medium">Serviço</th>
                <th className="py-1.5 pr-2 font-medium">Un</th>
                <th className="py-1.5 pr-2 font-medium">Qtd. planejada</th>
                <th className="py-1.5 pr-2 font-medium">Ritmo</th>
                <th className="py-1.5 pr-2 font-medium">Início</th>
                <th className="py-1.5 pr-2 font-medium">Fim</th>
                <th className="py-1.5 font-medium">Produção real</th>
              </tr>
            </thead>
            <tbody>
              {producao.map((l) => {
                const ref = escopo[l.node.wbs];
                return (
                  <tr key={l.node.wbs} className="border-b border-border/40">
                    <td className="py-1.5 pr-2 font-mono text-xs text-muted-foreground">
                      {l.node.wbs}
                    </td>
                    <td className="py-1.5 pr-2 font-medium">{l.node.nome}</td>
                    <td className="py-1.5 pr-2 tabular-nums">{ref?.unidade ?? "—"}</td>
                    <td className="py-1.5 pr-2 tabular-nums">{ref?.quantidade ?? "—"}</td>
                    <td className="py-1.5 pr-2 tabular-nums">
                      {l.ritmo !== "" ? `${l.ritmo}/dia` : "—"}
                    </td>
                    <td className="py-1.5 pr-2 tabular-nums">{diaParaDataIso(l.inicio, startDate)}</td>
                    <td className="py-1.5 pr-2 tabular-nums">{diaParaDataIso(l.fim, startDate)}</td>
                    <td className="py-1.5">
                      <Badge variant="outline">Pendente</Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
