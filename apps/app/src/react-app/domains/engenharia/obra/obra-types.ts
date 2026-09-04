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

/**
 * Status do ciclo de vida da obra (FASE 22).
 * `ARQUIVADA` é derivado de `Obra.arquivada` (soft-delete) — não é um valor
 * persistido separadamente para evitar segunda fonte de verdade.
 */
export type ObraStatus =
  | "PROPOSTA"
  | "PLANEJAMENTO"
  | "EM_EXECUCAO"
  | "CONCLUIDA"
  | "ARQUIVADA";

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
  /**
   * Metadado da obra/cadastro (FASE 22). Fonte única do CADASTRO.
   * NÃO é sobrescrito pelo Planejamento: as datas das atividades são fonte de
   * verdade do Planejamento (DATA_INICIO_OBRA). Se uma data derivada do
   * cronograma for apresentada, usa-se `inicioPlanejamento` (derivada), nunca
   * este campo.
   */
  dataInicio?: string | null;
  /** Data de fim como metadado opcional do cadastro (não derivada do cronograma). */
  dataFim?: string | null;
  /** Localização da obra (opcional). */
  localizacao?: string | null;
  /** Responsável pela obra (opcional). */
  responsavel?: string | null;
  /** Soft-delete: obra arquivada não aparece na lista ativa por padrão. */
  arquivada?: boolean;
  /** Preenchido quando a caracterização existir (etapa posterior ao cadastro). */
  caracterizacao?: ObraCaracterizacao | null;
  /** Resumo estrutural da EAP (preenchido quando a EAP da obra existir). */
  eap?: ObraEapSummary | null;
};

/** Entrada mínima de criação de obra (FASE 04.2-B). */
export type CreateObraInput = {
  nome: string;
  status?: ObraStatus;
  dataInicio?: string | null;
  dataFim?: string | null;
  localizacao?: string | null;
  responsavel?: string | null;
};

