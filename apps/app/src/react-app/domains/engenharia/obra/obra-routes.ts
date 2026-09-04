// Domínio Engenharia — rotas da entidade Obra (helpers puros, testáveis).
// Padrão de rota: /dominios/:domainId/obras[/:obraId[/:modulo]]
// FASE 04.2-B: adicionadas rotas de LISTA (/obras) e de NOVA OBRA (/obras/nova).
// FASE 20.x: módulos reorganizados por FASES do fluxo real da obra (sidebar).
// FASE 22: OBRA_FASES e OBRA_MODULE_LABEL passam a ser DERIVADOS do catálogo
// declarativo (obra-modules.ts) — fonte única de metadados dos módulos.
import type { ObraFase, ObraModule } from "./obra-types";
import {
  OBRA_FASES_ORDER,
  listModulesByFase,
  moduleLabel,
} from "./obra-modules";

export const DOMAIN_ENGENHARIA_ID = "engenharia";

/** Fases do ciclo de vida da obra, com seus módulos (ordem = fluxo real). */
export const OBRA_FASES: { id: ObraFase; label: string; modules: ObraModule[] }[] =
  OBRA_FASES_ORDER.map((fase) => ({
    id: fase,
    label: fase === "preparacao" ? "Preparação" : fase === "execucao" ? "Execução" : "Suporte",
    modules: listModulesByFase(fase).map((m) => m.id),
  }));

/** Módulos da casca da obra (ordem de exibição nas abas internas). */
export const OBRA_MODULES: ObraModule[] = OBRA_FASES.flatMap((fase) => fase.modules);

export const OBRA_MODULE_LABEL: Record<ObraModule, string> = OBRA_MODULES.reduce(
  (acc, id) => {
    acc[id] = moduleLabel(id);
    return acc;
  },
  {} as Record<ObraModule, string>,
);

/** Rota da LISTA de obras do domínio Engenharia. */
export function obrasListRoute(): string {
  return `/dominios/${DOMAIN_ENGENHARIA_ID}/obras`;
}

/** Rota da ação "+ Nova obra". */
export function obraNovaRoute(): string {
  return `${obrasListRoute()}/nova`;
}

/** Rota de edição de uma obra. */
export function obraEditarRoute(obraId: string): string {
  return `${obrasListRoute()}/${encodeURIComponent(obraId.trim())}/editar`;
}

/** Rota inicial do domínio Engenharia (lista de obras). */
export function engenhariaDomainHome(): string {
  return obrasListRoute();
}

/** Rota de uma obra (e, opcionalmente, de um módulo da obra). */
export function obraRoute(obraId: string, modulo?: ObraModule | null): string {
  const id = encodeURIComponent(obraId.trim());
  const base = `${obrasListRoute()}/${id}`;
  return modulo ? `${base}/${modulo}` : base;
}

/** Guarda de tipo: "eap" | "frentes" | ... vale como ObraModule. */
export function isObraModule(value: string | null | undefined): value is ObraModule {
  return typeof value === "string" && (OBRA_MODULES as string[]).includes(value);
}

