/** @jsxImportSource react */
import { useMemo } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getEapNodesForObra } from "../obra-eap-repository";
import type { Obra } from "../obra-types";

/**
 * Página Disciplinas da casca (FASE 20.x).
 * As 10 DISCIPLINA (nível 1) da EAP com a contagem de pacotes e trabalhos
 * agregados. Tudo DERIVADO dos nós reais — nunca uma fonte independente.
 */
export function ObraDisciplinas({ obra }: { obra: Obra }) {
  const nodes = useMemo(() => getEapNodesForObra(obra.id), [obra.id]);

  const disciplinas = useMemo(() => {
    const raizes = nodes.filter((n) => n.nivel === 1);
    return raizes.map((raiz) => {
      const filhos = nodes.filter((n) => n.pai === raiz.wbs);
      const pacotes = filhos.filter((n) => n.tipo === "PACOTE").length;
      const trabalhos = filhos.reduce((acc, filho) => {
        const netos = nodes.filter((n) => n.pai === filho.wbs);
        return acc + netos.filter((n) => n.tipo === "TRABALHO").length;
      }, 0);
      return {
        wbs: raiz.wbs,
        nome: raiz.nome,
        ordem: raiz.ordem,
        pacotes,
        trabalhos,
      };
    });
  }, [nodes]);

  if (disciplinas.length === 0) {
    return (
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Disciplinas</CardTitle>
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
          <CardTitle>Disciplinas</CardTitle>
          <CardDescription>
            As {disciplinas.length} disciplinas (nível 1) da EAP com seus pacotes
            e trabalhos agregados.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          {disciplinas.map((d) => (
            <div
              key={d.wbs}
              className="flex items-center justify-between border-b border-border/60 pb-2 last:border-b-0 last:pb-0"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground">{d.wbs}</span>
                <span className="truncate font-medium">{d.nome}</span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Badge variant="outline">{d.pacotes} pacotes</Badge>
                <Badge variant="outline">{d.trabalhos} trabalhos</Badge>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
