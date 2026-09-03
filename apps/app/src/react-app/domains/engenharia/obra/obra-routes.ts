// Domínio Engenharia — rotas da entidade Obra (helpers puros, testáveis).
// Padrão de rota: /dominios/:domainId/obras[/:obraId[/:modulo]]
// FASE 04.2-B: adicionadas rotas de LISTA (/obras) e de NOVA OBRA (/obras/nova).
// FASE 20.x: módulos reorganizados por FASES do fluxo real da obra (sidebar).
import type { ObraFase, ObraModule } from "./obra-types";

export const DOMAIN_ENGENHARIA_ID = "engenharia";

/** Fases do ciclo de vida da obra, com seus módulos (ordem = fluxo real). */
export const OBRA_FASES: { id: ObraFase; label: string; modules: ObraModule[] }[] = [
  {
    id: "preparacao",
    label: "Preparação",
    modules: [
      "visao-geral",
      "caracterizacao",
      "eap",
      "disciplinas",
      "servicos",
      "planejamento",
      "linha-de-balanco",
    ],
  },
  {
    id: "execucao",
    label: "Execução",
    modules: ["frentes", "producao", "rdo"],
  },
  {
    id: "suporte",
    label: "Suporte",
    modules: ["ia"],
  },
];

/** Módulos da casca da obra (ordem de exibição nas abas internas). */
export const OBRA_MODULES: ObraModule[] = OBRA_FASES.flatMap((fase) => fase.modules);

export const OBRA_MODULE_LABEL: Record<ObraModule, string> = {
  "visao-geral": "Visão Geral",
  caracterizacao: "Caracterização",
  eap: "EAP",
  disciplinas: "Disciplinas",
  servicos: "Serviços",
  planejamento: "Planejamento",
  "linha-de-balanco": "Linha de Balanço",
  frentes: "Frentes de Serviço",
  producao: "Produção",
  rdo: "RDO",
  ia: "IA",
};

/** Rota da LISTA de obras do domínio Engenharia. */
export function obrasListRoute(): string {
  return `/dominios/${DOMAIN_ENGENHARIA_ID}/obras`;
}

/** Rota da ação "+ Nova obra". */
export function obraNovaRoute(): string {
  return `${obrasListRoute()}/nova`;
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

