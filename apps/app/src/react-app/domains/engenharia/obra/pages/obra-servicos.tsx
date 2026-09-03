/** @jsxImportSource react */
import { useMemo } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getEapNodesForObra } from "../obra-eap-repository";
import { derivarPlanejamentoCompleto, diaParaDataIso } from "../obra-planejamento-data";
import type { Obra } from "../obra-types";

/**
 * Página Serviços da casca (FASE 20.x).
 * Os 47 TRABALHO (nível 3) da EAP com duração, datas e caminho crítico,
 * DERIVADOS do planejamento (mesma lógica da planilha nativa).
 */
export function ObraServicos({ obra }: { obra: Obra }) {
  const nodes = useMemo(() => getEapNodesForObra(obra.id), [obra.id]);
  const linhas = useMemo(() => derivarPlanejamentoCompleto(nodes), [nodes]);

  const servicos = useMemo(
    () => linhas.filter((l) => l.node.tipo === "TRABALHO"),
    [linhas],
  );

  if (servicos.length === 0) {
    return (
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Serviços</CardTitle>
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
          <CardTitle>Serviços</CardTitle>
          <CardDescription>
            Os {servicos.length} trabalhos (nível 3) da EAP com duração, datas e
            caminho crítico derivados do planejamento.
          </CardDescription>
        </CardHeader>
        <CardContent className="max-h-[70vh] overflow-auto">
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
              {servicos.map((l) => {
                const temData = l.duracao > 0;
                return (
                  <tr key={l.node.wbs} className="border-b border-border/40">
                    <td className="py-1.5 pr-2 font-mono text-xs text-muted-foreground">
                      {l.node.wbs}
                    </td>
                    <td className="py-1.5 pr-2 font-medium">{l.node.nome}</td>
                    <td className="py-1.5 pr-2 tabular-nums">
                      {l.duracao > 0 ? `${l.duracao} d` : "—"}
                    </td>
                    <td className="py-1.5 pr-2 tabular-nums">
                      {temData ? diaParaDataIso(l.inicio) : "—"}
                    </td>
                    <td className="py-1.5 pr-2 tabular-nums">
                      {temData ? diaParaDataIso(l.fim) : "—"}
                    </td>
                    <td className="py-1.5">
                      {l.critico === "CRÍTICO" ? (
                        <Badge variant="destructive">Crítico</Badge>
                      ) : l.critico === "Sequencial" ? (
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
        </CardContent>
      </Card>
    </div>
  );
}
