/** @jsxImportSource react */
import { useMemo } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getEapNodesForObra } from "../obra-eap-repository";
import type { Obra } from "../obra-types";

/**
 * Página Frentes de Serviço da casca (FASE 20.x).
 *
 * Frente = natureza/especialidade do trabalho. Para a obra real, as frentes são
 * DERIVADAS das disciplinas raiz da EAP real (81 nós) — nunca de outra obra.
 * Cada disciplina raiz vira uma frente, com a contagem de pacotes/trabalhos.
 */
export function ObraFrentes({ obra }: { obra: Obra }) {
  const nodes = useMemo(() => getEapNodesForObra(obra.id), [obra.id]);

  const frentes = useMemo(() => {
    const raizes = nodes.filter((n) => n.nivel === 1);
    return raizes.map((raiz) => {
      const filhos = nodes.filter((n) => n.pai === raiz.wbs);
      const pacotes = filhos.filter((n) => n.tipo === "PACOTE").length;
      const trabalhos = filhos.filter((n) => n.tipo === "TRABALHO").length;
      return {
        wbs: raiz.wbs,
        nome: raiz.nome,
        pacotes,
        trabalhos,
        total: filhos.length,
      };
    });
  }, [nodes]);

  if (frentes.length === 0) {
    return (
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Frentes de Serviço</CardTitle>
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
          <CardTitle>Frentes de Serviço</CardTitle>
          <CardDescription>
            As {frentes.length} frentes (disciplinas raiz) da EAP real da obra,
            com a quantidade de pacotes e trabalhos vinculados.
          </CardDescription>
        </CardHeader>
        <CardContent className="max-h-[70vh] overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-1.5 pr-2 font-medium">WBS</th>
                <th className="py-1.5 pr-2 font-medium">Frente</th>
                <th className="py-1.5 pr-2 font-medium">Pacotes</th>
                <th className="py-1.5 pr-2 font-medium">Trabalhos</th>
                <th className="py-1.5 font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {frentes.map((f) => (
                <tr key={f.wbs} className="border-b border-border/40">
                  <td className="py-1.5 pr-2 font-mono text-xs text-muted-foreground">
                    {f.wbs}
                  </td>
                  <td className="py-1.5 pr-2 font-medium">{f.nome}</td>
                  <td className="py-1.5 pr-2 tabular-nums">{f.pacotes}</td>
                  <td className="py-1.5 pr-2 tabular-nums">{f.trabalhos}</td>
                  <td className="py-1.5">
                    <Badge variant="outline">{f.total}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
