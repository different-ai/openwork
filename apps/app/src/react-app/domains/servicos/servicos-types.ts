// Capacidade genérica de Serviços — contrato reutilizável (FASE 21).
// Este módulo NÃO conhece nenhum domínio consumidor nem entidade específica.
// A tabela renderiza QUALQUER ServicosData fornecido por um adapter do domínio.
//
// FASE 21: contrato criado PREPARADO para a FASE 22 (orçamento, medição,
// indicadores). Os campos opcionais abaixo antecipam essas necessidades, mas
// NENHUM número fictício é inventado: só são preenchidos quando houver dado real.

/** Status de um serviço (derivado dos dados; nunca inventado). */
export type ServicoStatus = "CRÍTICO" | "Sequencial" | "—";

/** Item de serviço exibido na tabela. */
export type ServicoItem = {
  /** Identificador estável (ex.: WBS). */
  id: string;
  /** Código curto (ex.: WBS). */
  codigo: string;
  /** Nome do serviço. */
  nome: string;
  /** Duração em dias (0 = sem duração definida). */
  duracao: number;
  /** Data ISO de início (null = sem data). */
  inicio: string | null;
  /** Data ISO de fim (null = sem data). */
  fim: string | null;
  status: ServicoStatus;
  // --- Campos preparados para FASE 22 (opcionais; só preenchidos com dado real) ---
  /** Unidade de medida (ex.: "m²", "m³", "un"). */
  unidade?: string | null;
  /** Quantidade de escopo. */
  quantidade?: number | null;
  /** Produtividade declarada (ex.: "8 m³/dia"). */
  produtividade?: string | null;
  /** Predecessora (WBS) quando existir. */
  predecessora?: string | null;
};

/** Contrato consumido pela tabela de Serviços. */
export type ServicosData = {
  /** Título do contexto (ex.: "Serviços"). */
  title: string;
  /** Detalhe do contexto fornecido pelo adapter. */
  subtitle?: string;
  items: ServicoItem[];
};

/** Resumo derivado dos itens (KPIs). */
export type ServicosSummary = {
  total: number;
  criticos: number;
  sequenciais: number;
  comDuracao: number;
};
