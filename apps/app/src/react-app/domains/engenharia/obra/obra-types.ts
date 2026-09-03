// Domínio Engenharia — entidade Obra (tipos).
// A Obra NÃO pertence ao Core: pertence ao domínio Engenharia (Core → Domínio → Entidade).
// FASE 04.2-B: caracterizacao/eap tornam-se OPCIONAIS — uma obra nova nasce apenas com
// identificação; caracterização e EAP são etapas posteriores (não fazem parte do cadastro V1).
export type ObraModule =
  | "visao-geral"
  | "caracterizacao"
  | "eap"
  | "disciplinas"
  | "servicos"
  | "planejamento"
  | "linha-de-balanco"
  | "frentes"
  | "producao"
  | "rdo"
  | "ia";

/** Fase do ciclo de vida real da obra (agrupa módulos na sidebar). */
export type ObraFase = "preparacao" | "execucao" | "suporte";

export type ObraStatus = "PROPOSTA";

export type ObraEapSummary = {
  status: ObraStatus;
  total: number;
  raizes: number;
  pacotes: number;
  trabalhos: number;
};

export type ObraCaracterizacao = {
  torres: number;
  lajes: number;
  apartamentosPorPavimento: number;
  subsolos: number;
  sistemaConstrutivo: string;
};

export type Obra = {
  id: string;
  nome: string;
  status: ObraStatus;
  /** Preenchido quando a caracterização existir (etapa posterior ao cadastro). */
  caracterizacao?: ObraCaracterizacao | null;
  /** Resumo estrutural da EAP (preenchido quando a EAP da obra existir). */
  eap?: ObraEapSummary | null;
};

/** Entrada mínima de criação de obra (FASE 04.2-B). */
export type CreateObraInput = {
  nome: string;
  status?: ObraStatus;
};

