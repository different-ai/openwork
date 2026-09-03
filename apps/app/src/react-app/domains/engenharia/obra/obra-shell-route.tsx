/** @jsxImportSource react */
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { OBRA_MODULES, OBRA_MODULE_LABEL, obraRoute } from "./obra-routes";
import { useObraStore } from "./obra-store";
import { useObraRepository } from "./obra-repository";
import type { ObraModule } from "./obra-types";
import { ObraCaracterizacao } from "./pages/obra-caracterizacao";
import { ObraDisciplinas } from "./pages/obra-disciplinas";
import { ObraEap } from "./pages/obra-eap";
import { ObraLobGrade } from "./pages/obra-lob-grade";
import { ObraModuloPlaceholder } from "./pages/obra-modulo-placeholder";
import { ObraPlanejamento } from "./pages/obra-planejamento";
import { ObraServicos } from "./pages/obra-servicos";
import { ObraVisaoGeral } from "./pages/obra-visao-geral";

const MODULE_DESCRIPTIONS: Record<
  Exclude<ObraModule, "visao-geral" | "caracterizacao" | "eap" | "disciplinas" | "servicos" | "planejamento" | "linha-de-balanco">,
  string
> = {
  frentes:
    "A estrutura deste módulo será vinculada posteriormente aos elementos da EAP (elemento_eap_id).",
  producao: "Produção da obra será vinculada aos elementos da EAP em fase futura.",
  rdo: "Registro Diário de Obra (RDO) será vinculado aos elementos da EAP em fase futura.",
  ia: "Assistência de IA da obra será vinculada aos elementos da EAP em fase futura.",
};

/**
 * Casca da entidade Obra (domínio Engenharia): navegação interna entre os módulos
 * (Visão Geral, EAP, Frentes, Planejamento, Produção, RDO, IA).
 */
export function ObraShellRoute({
  obraId,
  modulo,
}: {
  obraId: string;
  modulo: ObraModule | null;
}) {
  const navigate = useNavigate();
  const selectModule = useObraStore((state) => state.selectModule);
  const obra = useObraRepository((state) =>
    state.obras.find((candidate) => candidate.id === obraId),
  );

  if (!obra) {
    return (
      <div className="flex min-h-[60vh] w-full flex-col items-center justify-center gap-2 p-8 text-center">
        <p className="text-lg font-semibold">Obra não encontrada</p>
        <p className="text-sm text-muted-foreground">{obraId}</p>
      </div>
    );
  }

  const activeModule: ObraModule = modulo ?? "visao-geral";

  const content =
    activeModule === "eap" ? (
      <ObraEap obra={obra} />
    ) : activeModule === "caracterizacao" ? (
      <ObraCaracterizacao obra={obra} />
    ) : activeModule === "disciplinas" ? (
      <ObraDisciplinas obra={obra} />
    ) : activeModule === "servicos" ? (
      <ObraServicos obra={obra} />
    ) : activeModule === "frentes" ? (
      <ObraModuloPlaceholder titulo="Frentes de Serviço" descricao={MODULE_DESCRIPTIONS.frentes} />
    ) : activeModule === "planejamento" ? (
      <ObraPlanejamento obra={obra} />
    ) : activeModule === "linha-de-balanco" ? (
      <ObraLobGrade obra={obra} />
    ) : activeModule === "producao" ? (
      <ObraModuloPlaceholder titulo="Produção" descricao={MODULE_DESCRIPTIONS.producao} />
    ) : activeModule === "rdo" ? (
      <ObraModuloPlaceholder titulo="RDO" descricao={MODULE_DESCRIPTIONS.rdo} />
    ) : activeModule === "ia" ? (
      <ObraModuloPlaceholder titulo="IA" descricao={MODULE_DESCRIPTIONS.ia} />
    ) : (
      <ObraVisaoGeral obra={obra} />
    );

  return (
    <div className="flex h-full w-full flex-col gap-4 overflow-auto p-4">
      <div className="flex flex-col gap-0.5">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Engenharia · Obra
        </span>
        <h1 className="text-xl font-bold">{obra.nome}</h1>
      </div>

      <nav className="flex flex-wrap items-center gap-1.5" aria-label="Módulos da obra">
        {OBRA_MODULES.map((module) => {
          const active = module === activeModule;
          return (
            <Button
              key={module}
              type="button"
              size="sm"
              variant={active ? "default" : "ghost"}
              className={cn(active && "text-primary-foreground")}
              data-obra-module={module}
              onClick={() => {
                selectModule(obraId, module);
                navigate(obraRoute(obraId, module));
              }}
            >
              {OBRA_MODULE_LABEL[module]}
            </Button>
          );
        })}
      </nav>

      <div className="min-h-0 flex-1">{content}</div>
    </div>
  );
}
