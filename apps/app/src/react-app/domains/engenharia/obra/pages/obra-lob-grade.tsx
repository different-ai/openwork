/** @jsxImportSource react */
import { useMemo } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { getEapNodesForObra } from "../obra-eap-repository";
import { derivarGradeLob } from "../obra-lob-data";
import type { Obra } from "../obra-types";

/**
 * Grade Linha de Balanço (FASE 20.x).
 * Visualização tempo × serviço (como a aba LINHA DE BALANÇO (GRADE) da
 * planilha nativa): semanas na horizontal, serviços na vertical, célula ativa
 * quando o serviço está em execução. Tudo DERIVADO dos nós reais + datas.
 */
export function ObraLobGrade({ obra }: { obra: Obra }) {
  const nodes = useMemo(() => getEapNodesForObra(obra.id), [obra.id]);
  const { semanas, linhas } = useMemo(() => derivarGradeLob(nodes), [nodes]);

  if (linhas.length === 0) {
    return (
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Linha de Balanço</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Esta obra ainda não possui EAP definida.
        </CardContent>
      </Card>
    );
  }

  const criticos = linhas.filter((l) => l.critico === "CRÍTICO").length;

  return (
    <div className="flex w-full flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Linha de Balanço</CardTitle>
          <CardDescription>
            {semanas.length} semanas · {linhas.length} serviços com duração ·{" "}
            {criticos} críticos. Tempo na horizontal, serviços na vertical.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>Início {semanas[0]?.inicio}</span>
            <span>·</span>
            <span>Fim {semanas[semanas.length - 1]?.fim}</span>
          </div>

          <div className="max-h-[70vh] overflow-auto rounded-lg border border-border">
            <div className="min-w-max">
              {/* Cabeçalho de semanas */}
              <div className="sticky top-0 z-10 flex border-b border-border bg-background/95 backdrop-blur">
                <div className="sticky left-0 z-20 w-64 shrink-0 border-r border-border bg-background px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Serviço
                </div>
                <div className="flex">
                  {semanas.map((semana) => (
                    <div
                      key={semana.index}
                      className="flex w-8 shrink-0 items-center justify-center border-r border-border/40 px-0.5 text-[10px] font-medium text-muted-foreground"
                      title={`${semana.inicio} → ${semana.fim}`}
                    >
                      {semana.label.replace("SEM ", "")}
                    </div>
                  ))}
                </div>
              </div>

              {/* Linhas de serviço */}
              {linhas.map((linha) => (
                <div
                  key={linha.node.wbs}
                  className="flex border-b border-border/40 last:border-b-0"
                >
                  <div className="sticky left-0 z-10 flex w-64 shrink-0 items-center gap-2 border-r border-border bg-background px-3 py-1.5">
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {linha.node.wbs}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">
                      {linha.node.nome}
                    </span>
                    {linha.critico === "CRÍTICO" ? (
                      <Badge variant="destructive" className="shrink-0 px-1.5 text-[10px]">
                        C
                      </Badge>
                    ) : null}
                  </div>
                  <div className="flex">
                    {semanas.map((semana) => {
                      const ativa = linha.semanasAtivas.includes(semana.index);
                      return (
                        <div
                          key={semana.index}
                          className={cn(
                            "h-7 w-8 shrink-0 border-r border-border/40",
                            ativa
                              ? linha.critico === "CRÍTICO"
                                ? "bg-destructive/70"
                                : "bg-primary/70"
                              : "bg-transparent",
                          )}
                          title={
                            ativa
                              ? `${linha.node.nome} · ${semana.label}`
                              : undefined
                          }
                        />
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
