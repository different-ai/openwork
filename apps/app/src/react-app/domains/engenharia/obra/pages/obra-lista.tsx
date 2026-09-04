/** @jsxImportSource react */
import { useState } from "react";
import { Archive, ArchiveRestore, Pencil, Plus, Trash2 } from "lucide-react";
import { useNavigate } from "react-router";

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ObraHelpButton } from "../obra-help";
import { statusEfetivo, useObraRepository } from "../obra-repository";
import { obraEditarRoute, obraNovaRoute, obraRoute } from "../obra-routes";
import { useObraStore } from "../obra-store";
import type { Obra, ObraStatus } from "../obra-types";

const STATUS_OPTIONS: { value: ObraStatus | "TODOS"; label: string }[] = [
  { value: "TODOS", label: "Todos os status" },
  { value: "PROPOSTA", label: "Proposta" },
  { value: "PLANEJAMENTO", label: "Planejamento" },
  { value: "EM_EXECUCAO", label: "Em execução" },
  { value: "CONCLUIDA", label: "Concluída" },
  { value: "ARQUIVADA", label: "Arquivada" },
];

const STATUS_TONE: Record<ObraStatus, string> = {
  PROPOSTA: "border-sky-500/40 bg-sky-500/10 text-sky-700",
  PLANEJAMENTO: "border-violet-500/40 bg-violet-500/10 text-violet-700",
  EM_EXECUCAO: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700",
  CONCLUIDA: "border-slate-400/40 bg-slate-400/10 text-slate-600",
  ARQUIVADA: "border-muted-foreground/40 bg-muted-foreground/10 text-muted-foreground",
};

/**
 * Conteúdo presentacional da Central de Obras (testável via SSR).
 * Recebe obras + estado + callbacks; a página conecta ao repositório/store.
 * FASE 22: busca, filtro por status, ações por card (editar/arquivar/excluir
 * com confirmação em duas etapas) e destaque da obra ativa.
 */
export function ObraListaContent({
  obras,
  activeObraId,
  onAbrir,
  onEditar,
  onArquivar,
  onRestaurar,
  onExcluir,
}: {
  obras: readonly Obra[];
  activeObraId?: string | null;
  onAbrir: (obra: Obra) => void;
  onEditar: (obra: Obra) => void;
  onArquivar: (obra: Obra) => void;
  onRestaurar: (obra: Obra) => void;
  onExcluir: (obra: Obra) => void;
}) {
  const [busca, setBusca] = useState("");
  const [filtroStatus, setFiltroStatus] = useState<ObraStatus | "TODOS">("TODOS");

  const termo = busca.trim().toLowerCase();
  const filtradas = obras.filter((obra) => {
    const status = statusEfetivo(obra);
    if (filtroStatus !== "TODOS" && status !== filtroStatus) return false;
    if (termo) {
      const alvo = `${obra.nome} ${obra.id} ${obra.localizacao ?? ""}`.toLowerCase();
      if (!alvo.includes(termo)) return false;
    }
    return true;
  });

  return (
    <div className="flex h-full w-full flex-col gap-4 overflow-auto p-4">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold leading-tight">Central de Obras</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Projetos de trabalho registrados no domínio Engenharia.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ObraHelpButton />
          <Button type="button" size="sm" onClick={() => onAbrir({ id: "nova" } as Obra)} data-obra-nova>
            <Plus className="size-4" aria-hidden="true" />
            Nova obra
          </Button>
        </div>
      </header>

      {/* Busca + filtro */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center" data-obra-filtros>
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor="obra-busca" className="text-xs text-muted-foreground">
            Buscar
          </Label>
          <Input
            id="obra-busca"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Nome, ID ou localização…"
            data-obra-busca
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="obra-status" className="text-xs text-muted-foreground">
            Status
          </Label>
          <select
            id="obra-status"
            value={filtroStatus}
            onChange={(e) => setFiltroStatus(e.target.value as ObraStatus | "TODOS")}
            data-obra-status-filtro
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {filtradas.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Nenhuma obra</EmptyTitle>
          </EmptyHeader>
          <EmptyDescription>
            {obras.length === 0
              ? "Crie a primeira obra para começar a trabalhar neste domínio."
              : "Nenhuma obra corresponde aos filtros atuais."}
          </EmptyDescription>
        </Empty>
      ) : (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
          {filtradas.map((obra) => {
            const status = statusEfetivo(obra);
            const ativa = obra.id === activeObraId;
            return (
              <Card
                key={obra.id}
                data-obra-card={obra.id}
                data-obra-ativa={ativa || undefined}
                className="min-w-0"
              >
                <CardContent className="flex flex-col gap-2 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{obra.nome}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Badge variant="outline" className={STATUS_TONE[status]}>
                          {status}
                        </Badge>
                        {ativa ? (
                          <Badge variant="outline" className="border-primary/40 bg-primary/10 text-primary">
                            Ativa
                          </Badge>
                        ) : null}
                      </div>
                    </div>
                    <span className="shrink-0 truncate text-xs text-muted-foreground">
                      {obra.id}
                    </span>
                  </div>

                  {(obra.dataInicio || obra.localizacao || obra.responsavel) ? (
                    <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                      {obra.dataInicio ? <span>Início: {obra.dataInicio}</span> : null}
                      {obra.localizacao ? <span>Local: {obra.localizacao}</span> : null}
                      {obra.responsavel ? <span>Responsável: {obra.responsavel}</span> : null}
                    </div>
                  ) : null}

                  <div className="flex items-center gap-1 pt-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="default"
                      onClick={() => onAbrir(obra)}
                      aria-label={`Abrir ${obra.nome}`}
                    >
                      Abrir
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => onEditar(obra)}
                      aria-label={`Editar ${obra.nome}`}
                      data-obra-editar={obra.id}
                    >
                      <Pencil className="size-3.5" aria-hidden="true" />
                    </Button>
                    {obra.arquivada ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => onRestaurar(obra)}
                        aria-label={`Restaurar ${obra.nome}`}
                        data-obra-restaurar={obra.id}
                      >
                        <ArchiveRestore className="size-3.5" aria-hidden="true" />
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => onArquivar(obra)}
                        aria-label={`Arquivar ${obra.nome}`}
                        data-obra-arquivar={obra.id}
                      >
                        <Archive className="size-3.5" aria-hidden="true" />
                      </Button>
                    )}
                    <DeleteObraButton obra={obra} onExcluir={onExcluir} />
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Exclusão com confirmação em duas etapas (segurança contra exclusão acidental). */
function DeleteObraButton({ obra, onExcluir }: { obra: Obra; onExcluir: (obra: Obra) => void }) {
  const [confirmado, setConfirmado] = useState(false);
  return (
    <AlertDialog
      open={confirmado}
      onOpenChange={(open) => {
        if (!open) setConfirmado(false);
      }}
    >
      <AlertDialogTrigger
        render={
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`Excluir ${obra.nome}`}
            data-obra-excluir={obra.id}
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
          </Button>
        }
      />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Excluir obra definitivamente?</AlertDialogTitle>
          <AlertDialogDescription>
            Esta ação exclui permanentemente a obra <strong>{obra.nome}</strong> e sua EAP.
            Para evitar exclusão acidental, confirme digitando o nome da obra abaixo.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-1">
          <Label htmlFor="confirmar-exclusao" className="text-xs text-muted-foreground">
            Digite o nome da obra para confirmar
          </Label>
          <Input
            id="confirmar-exclusao"
            value={confirmado ? "" : ""}
            onChange={(e) => setConfirmado(e.target.value === obra.nome)}
            placeholder={obra.nome}
            data-obra-excluir-confirmacao
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel
            render={<Button type="button" variant="ghost">Cancelar</Button>}
          />
          <AlertDialogAction
            disabled={!confirmado}
            render={
              <Button type="button" variant="destructive" disabled={!confirmado}>
                Excluir definitivamente
              </Button>
            }
          >
            Excluir definitivamente
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Conector: Central de Obras a partir da fonte única (repositório + store). */
export function ObraListaPage() {
  const navigate = useNavigate();
  const obras = useObraRepository((state) => state.obras);
  const activeObraId = useObraStore((state) => state.activeObraId);
  const archiveObra = useObraRepository((state) => state.archiveObra);
  const unarchiveObra = useObraRepository((state) => state.unarchiveObra);
  const deleteObra = useObraRepository((state) => state.deleteObra);

  return (
    <ObraListaContent
      obras={obras}
      activeObraId={activeObraId}
      onAbrir={(obra) => {
        if (obra.id === "nova") {
          navigate(obraNovaRoute());
          return;
        }
        navigate(obraRoute(obra.id));
      }}
      onEditar={(obra) => navigate(obraEditarRoute(obra.id))}
      onArquivar={(obra) => archiveObra(obra.id)}
      onRestaurar={(obra) => unarchiveObra(obra.id)}
      onExcluir={(obra) => deleteObra(obra.id)}
    />
  );
}
