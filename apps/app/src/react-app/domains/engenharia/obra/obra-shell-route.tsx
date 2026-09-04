/** @jsxImportSource react */
import type { ReactNode } from "react";
import { useEffect } from "react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { OBRA_FASES, OBRA_MODULE_LABEL, obraRoute } from "./obra-routes";
import { listModulesByFase, moduleFase } from "./obra-modules";
import { useObraStore } from "./obra-store";
import { useObraRepository } from "./obra-repository";
import type { Obra, ObraFase, ObraModule } from "./obra-types";
import { ObraCaracterizacao } from "./pages/obra-caracterizacao";
import { ObraDisciplinas } from "./pages/obra-disciplinas";
import { ObraEap } from "./pages/obra-eap";
import { ObraFrentes } from "./pages/obra-frentes";
import { ObraLobGrade } from "./pages/obra-lob-grade";
import { ObraModuloPlaceholder } from "./pages/obra-modulo-placeholder";
import { ObraPlanejamento } from "./pages/obra-planejamento";
import { ObraProducao } from "./pages/obra-producao";
import { ObraServicos } from "./pages/obra-servicos";
import { ObraVisaoGeral } from "./pages/obra-visao-geral";

/**
 * Resolução de TELA dos módulos (FASE 22).
 * Camada de renderização: mapeia cada id de módulo para o componente que o
 * renderiza. O catálogo (obra-modules.ts) permanece declarativo (sem React);
 * esta é a camada apropriada para a resolução da tela.
 */
const MODULE_RENDERERS: Record<ObraModule, (obra: Obra) => ReactNode> = {
  "visao-geral": (obra) => <ObraVisaoGeral obra={obra} />,
  caracterizacao: (obra) => <ObraCaracterizacao obra={obra} />,
  eap: (obra) => <ObraEap obra={obra} />,
  disciplinas: (obra) => <ObraDisciplinas obra={obra} />,
  servicos: (obra) => <ObraServicos obra={obra} />,
  planejamento: (obra) => <ObraPlanejamento obra={obra} />,
  "linha-de-balanco": (obra) => <ObraLobGrade obra={obra} />,
  frentes: (obra) => <ObraFrentes obra={obra} />,
  producao: (obra) => <ObraProducao obra={obra} />,
  rdo: (obra) => (
    <ObraModuloPlaceholder
      titulo="RDO"
      descricao="Registro Diário de Obra (RDO) será vinculado aos elementos da EAP em fase futura."
    />
  ),
  ia: (obra) => (
    <ObraModuloPlaceholder
      titulo="IA"
      descricao="Assistência de IA da obra será vinculada aos elementos da EAP em fase futura."
    />
  ),
};

/**
 * Casca da entidade Obra (domínio Engenharia) — FASE 21 / FASE 22.
 * Navegação em TABS POR FASE com subitens: uma barra de fases (Preparação,
 * Execução, Suporte) e, dentro da fase ativa, as abas dos módulos (subitens).
 * FASE 22: a navegação e o conteúdo são derivados do catálogo declarativo
 * (obra-modules.ts) + mapa de renderização — sem switch hardcoded.
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
  const setActiveObra = useObraStore((state) => state.setActiveObra);
  const obra = useObraRepository((state) =>
    state.obras.find((candidate) => candidate.id === obraId),
  );

  // Contexto da obra ativa: ao abrir uma obra, registra-a como ativa.
  useEffect(() => {
    if (obra) setActiveObra(obra.id);
  }, [obra, setActiveObra]);

  if (!obra) {
    return (
      <div className="flex min-h-[60vh] w-full flex-col items-center justify-center gap-2 p-8 text-center">
        <p className="text-lg font-semibold">Obra não encontrada</p>
        <p className="text-sm text-muted-foreground">{obraId}</p>
      </div>
    );
  }

  const activeModule: ObraModule = modulo ?? "visao-geral";
  const activeFase: ObraFase = moduleFase(activeModule);
  const activeModules = listModulesByFase(activeFase);

  const content = MODULE_RENDERERS[activeModule](obra);

  const goToModule = (module: ObraModule) => {
    selectModule(obraId, module);
    navigate(obraRoute(obraId, module));
  };

  return (
    <div className="flex h-full w-full flex-col gap-4 overflow-auto p-4">
      <div className="flex flex-col gap-0.5">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Engenharia · Obra
        </span>
        <h1 className="text-xl font-bold">{obra.nome}</h1>
      </div>

      {/* Tabs por fase (nível 1) */}
      <nav
        className="flex flex-wrap items-center gap-1.5 border-b border-border pb-2"
        aria-label="Fases da obra"
        data-obra-fases
      >
        {OBRA_FASES.map((fase) => {
          const active = fase.id === activeFase;
          return (
            <Button
              key={fase.id}
              type="button"
              size="sm"
              variant={active ? "default" : "ghost"}
              className={cn(active && "text-primary-foreground")}
              data-obra-fase={fase.id}
              onClick={() => {
                // Ao trocar de fase, navega para o primeiro módulo da fase.
                const primeiro = fase.modules[0];
                if (primeiro) goToModule(primeiro);
              }}
            >
              {fase.label}
            </Button>
          );
        })}
      </nav>

      {/* Subitens da fase ativa (nível 2) */}
      <nav
        className="flex flex-wrap items-center gap-1.5"
        aria-label={`Módulos da fase ${activeFase}`}
        data-obra-modulos
      >
        {activeModules.map((module) => {
          const active = module.id === activeModule;
          return (
            <Button
              key={module.id}
              type="button"
              size="sm"
              variant={active ? "secondary" : "ghost"}
              className={cn(active && "font-medium")}
              data-obra-module={module.id}
              onClick={() => goToModule(module.id)}
            >
              {OBRA_MODULE_LABEL[module.id]}
            </Button>
          );
        })}
      </nav>

      <div className="min-h-0 flex-1">{content}</div>
    </div>
  );
}
