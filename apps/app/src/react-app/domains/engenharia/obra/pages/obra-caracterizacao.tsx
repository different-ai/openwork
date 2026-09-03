/** @jsxImportSource react */
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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

/**
 * Página Caracterização da casca (FASE 20.x).
 * Dados estruturais da obra (torres, lajes, subsolos, sistema construtivo),
 * extraídos da Visão Geral para um módulo próprio na fase Preparação.
 */
export function ObraCaracterizacao({ obra }: { obra: Obra }) {
  return (
    <Card variant="outline" className="w-full">
      <CardHeader>
        <CardTitle>Caracterização</CardTitle>
        <CardDescription>
          Informações estruturais da obra (somente dados existentes no projeto).
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
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
      </CardContent>
    </Card>
  );
}
