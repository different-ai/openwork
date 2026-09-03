/** @jsxImportSource react */
import { Plus } from "lucide-react";
import { useNavigate } from "react-router";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { ObraHelpButton } from "../obra-help";
import { useObraRepository } from "../obra-repository";
import { obraNovaRoute, obraRoute } from "../obra-routes";
import type { Obra } from "../obra-types";

/**
 * Conteúdo presentacional da lista (testável via SSR com qualquer lista de obras).
 * A mesma fonte (ObraRepository) alimenta esta superfície e a navegação.
 */
export function ObraListaContent({ obras }: { obras: readonly Obra[] }) {
  const navigate = useNavigate();

  return (
    <div className="flex h-full w-full flex-col gap-4 overflow-auto p-4">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold leading-tight">Obras</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Projetos de trabalho registrados no domínio.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ObraHelpButton />
          <Button type="button" size="sm" onClick={() => navigate(obraNovaRoute())}>
            <Plus className="size-4" aria-hidden="true" />
            Nova obra
          </Button>
        </div>
      </header>

      {obras.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Nenhuma obra</EmptyTitle>
          </EmptyHeader>
          <EmptyDescription>
            Crie a primeira obra para começar a trabalhar neste domínio.
          </EmptyDescription>
        </Empty>
      ) : (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
          {obras.map((obra) => (
            <Card key={obra.id} data-obra-card={obra.id} className="min-w-0">
              <CardContent className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{obra.nome}</div>
                  <div className="mt-1 flex items-center gap-2">
                    <Badge variant="outline">{obra.status}</Badge>
                    <span className="truncate text-xs text-muted-foreground">
                      {obra.id}
                    </span>
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => navigate(obraRoute(obra.id))}
                  aria-label={`Abrir ${obra.nome}`}
                >
                  Abrir
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

/** Conector: lista de obras a partir da fonte única (repositório reativo). */
export function ObraListaPage() {
  const obras = useObraRepository((state) => state.obras);
  return <ObraListaContent obras={obras} />;
}

