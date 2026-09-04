// Domínio Engenharia — DATASET DE REFERÊNCIA ARES/PIEMARTA (FASE 20.x).
//
// ⚠️ SEPARAÇÃO DE FONTES (decisão do usuário 2026-09-03):
//   - Obra real (OBRA-MODELO-EAP-001) → EAP real de 81 nós + cronograma derivado.
//   - ARES/Piemarta → dataset de REFERÊNCIA/DEMONSTRAÇÃO para validar a estrutura
//     de Planejamento, Gantt e LOB. NÃO é o cronograma da obra real.
//
// Este arquivo NÃO é consumido pelo módulo Planejamento/Gantt/LOB da obra real.
// Ele existe para (a) documentar o modelo ARES e (b) servir de base a testes que
// validam que a estrutura de Planejamento/Gantt/LOB consegue consumir um
// cronograma com datas explícitas, predecessoras, %plan/%real e status.
//
// Fonte: aba PLANEJAMENTO (modelo legado, 15 atividades) + REDE (18 elos) +
// LINHA DE BALANÇO (11 serviços) da planilha ARES_MODELO_EXCEL_NATIVO_MVP_LOB.

/** Status de uma atividade no modelo ARES. */
export type AresStatusAtividade =
  | "concluido"
  | "em_andamento"
  | "planejado"
  | "atrasado";

/** Atividade de cronograma do dataset de referência ARES/Piemarta. */
export type AresAtividadeReferencia = {
  codigo: string;
  atividade: string;
  servico: string;
  frente: string;
  local: string;
  equipe: string;
  quantidade: number;
  duracao: number;
  inicio: string; // ISO yyyy-mm-dd
  fim: string; // ISO yyyy-mm-dd
  predecessora: string | null;
  percentualPlan: number; // 0–100
  percentualReal: number; // 0–100
  status: AresStatusAtividade;
};

/** Elo da rede de precedências do dataset de referência. */
export type AresEloRede = {
  id: string;
  predecessora: string;
  sucessora: string;
  tipoRelacao: "FS";
  defasagem: number;
  origem: string;
};

/** Identificação do dataset de referência (nunca confundir com a obra real). */
export const ARES_REFERENCIA = {
  obra: "Piemarta",
  empresa: "Empresa B",
  tipo: "Edificação vertical",
  natureza: "DATASET DE REFERÊNCIA/DEMONSTRAÇÃO — NÃO é a obra real",
  fonte: "ARES_MODELO_EXCEL_NATIVO_MVP_LOB_PROFISSIONAL_FINAL_WORK.xlsx",
} as const;

/** 15 atividades do cronograma ARES/Piemarta (aba PLANEJAMENTO, modelo legado). */
export const ARES_ATIVIDADES_REFERENCIA: AresAtividadeReferencia[] = [
  { codigo: "LOC-ATV", atividade: "Locação e implantação do canteiro", servico: "Locação de obra", frente: "FRENTE-000", local: "LOCAL-T1", equipe: "EQUIPE-001", quantidade: 1, duracao: 10, inicio: "2026-01-05", fim: "2026-01-16", predecessora: null, percentualPlan: 100, percentualReal: 100, status: "concluido" },
  { codigo: "FUN-ATV", atividade: "Blocos, baldrames e fundação", servico: "Fundação", frente: "FRENTE-001", local: "LOCAL-T1", equipe: "EQUIPE-002", quantidade: 1200, duracao: 40, inicio: "2026-01-19", fim: "2026-03-13", predecessora: "LOC-ATV", percentualPlan: 100, percentualReal: 100, status: "concluido" },
  { codigo: "EST-ATV1", atividade: "Estrutura - subsolo e pilotis", servico: "Estrutura", frente: "FRENTE-002", local: "LOCAL-T1", equipe: "EQUIPE-003", quantidade: 1800, duracao: 25, inicio: "2026-03-16", fim: "2026-04-17", predecessora: "FUN-ATV", percentualPlan: 100, percentualReal: 100, status: "concluido" },
  { codigo: "EST-ATV2", atividade: "Estrutura - pisos 1 a 5", servico: "Estrutura", frente: "FRENTE-002", local: "LOCAL-T1", equipe: "EQUIPE-003", quantidade: 2400, duracao: 35, inicio: "2026-04-20", fim: "2026-06-05", predecessora: "EST-ATV1", percentualPlan: 100, percentualReal: 100, status: "concluido" },
  { codigo: "EST-ATV3", atividade: "Estrutura - pisos 6 a 14", servico: "Estrutura", frente: "FRENTE-002", local: "LOCAL-T1", equipe: "EQUIPE-003", quantidade: 2300, duracao: 40, inicio: "2026-06-08", fim: "2026-07-31", predecessora: "EST-ATV2", percentualPlan: 55, percentualReal: 60, status: "em_andamento" },
  { codigo: "ALV-ATV1", atividade: "Alvenaria - pisos 1 a 7", servico: "Alvenaria", frente: "FRENTE-003", local: "LOCAL-T1", equipe: "EQUIPE-004", quantidade: 2500, duracao: 60, inicio: "2026-06-08", fim: "2026-08-28", predecessora: "EST-ATV2", percentualPlan: 100, percentualReal: 100, status: "concluido" },
  { codigo: "ALV-ATV2", atividade: "Alvenaria - pisos 8 a 14", servico: "Alvenaria", frente: "FRENTE-003", local: "LOCAL-T1", equipe: "EQUIPE-004", quantidade: 2500, duracao: 45, inicio: "2026-08-31", fim: "2026-10-30", predecessora: "ALV-ATV1", percentualPlan: 20, percentualReal: 28, status: "em_andamento" },
  { codigo: "REV-ATV1", atividade: "Revestimento interno - pisos 1 a 7", servico: "Revestimento interno", frente: "FRENTE-004", local: "LOCAL-T1", equipe: "EQUIPE-005", quantidade: 2400, duracao: 50, inicio: "2026-06-29", fim: "2026-09-04", predecessora: "ALV-ATV1", percentualPlan: 10, percentualReal: 5, status: "em_andamento" },
  { codigo: "REV-ATV2", atividade: "Revestimento interno - pisos 8 a 14", servico: "Revestimento interno", frente: "FRENTE-004", local: "LOCAL-T1", equipe: "EQUIPE-005", quantidade: 2100, duracao: 45, inicio: "2026-09-14", fim: "2026-11-13", predecessora: "ALV-ATV2", percentualPlan: 0, percentualReal: 0, status: "planejado" },
  { codigo: "CON-ATV", atividade: "Contrapiso de regularização", servico: "Contrapiso", frente: "FRENTE-004", local: "LOCAL-T1", equipe: "EQUIPE-011", quantidade: 4200, duracao: 45, inicio: "2026-08-03", fim: "2026-10-02", predecessora: "EST-ATV3", percentualPlan: 15, percentualReal: 4, status: "atrasado" },
  { codigo: "ELE-ATV", atividade: "Instalações elétricas", servico: "Instalações elétricas", frente: "FRENTE-005", local: "LOCAL-T1", equipe: "EQUIPE-006", quantidade: 8400, duracao: 50, inicio: "2026-06-08", fim: "2026-08-14", predecessora: "EST-ATV2", percentualPlan: 55, percentualReal: 55, status: "em_andamento" },
  { codigo: "HID-ATV", atividade: "Instalações hidráulicas", servico: "Instalações hidráulicas", frente: "FRENTE-005", local: "LOCAL-T1", equipe: "EQUIPE-007", quantidade: 2800, duracao: 45, inicio: "2026-06-08", fim: "2026-08-07", predecessora: "EST-ATV2", percentualPlan: 60, percentualReal: 70, status: "em_andamento" },
  { codigo: "IMP-ATV", atividade: "Impermeabilização", servico: "Impermeabilização", frente: "FRENTE-006", local: "LOCAL-T1", equipe: "EQUIPE-008", quantidade: 2400, duracao: 35, inicio: "2026-08-03", fim: "2026-09-18", predecessora: "EST-ATV3", percentualPlan: 0, percentualReal: 0, status: "planejado" },
  { codigo: "PIN-ATV", atividade: "Pintura de paredes e tetos", servico: "Pintura", frente: "FRENTE-006", local: "LOCAL-T1", equipe: "EQUIPE-009", quantidade: 6800, duracao: 50, inicio: "2026-11-16", fim: "2027-01-22", predecessora: "REV-ATV2", percentualPlan: 0, percentualReal: 0, status: "planejado" },
  { codigo: "ESQ-ATV", atividade: "Instalação de esquadrias", servico: "Esquadrias", frente: "FRENTE-006", local: "LOCAL-T1", equipe: "EQUIPE-010", quantidade: 504, duracao: 45, inicio: "2026-11-02", fim: "2027-01-01", predecessora: "ALV-ATV2", percentualPlan: 0, percentualReal: 0, status: "planejado" },
];

/** 18 elos da rede de precedências ARES/Piemarta (aba REDE). */
export const ARES_REDE_REFERENCIA: AresEloRede[] = [
  { id: "REDE-001", predecessora: "PLAN-001", sucessora: "ALV-ATV2", tipoRelacao: "FS", defasagem: 3, origem: "R1: precedente explicito do legado" },
  { id: "REDE-002", predecessora: "EST-ATV3", sucessora: "CON-ATV", tipoRelacao: "FS", defasagem: 3, origem: "R1: precedente explicito do legado" },
  { id: "REDE-003", predecessora: "EST-ATV2", sucessora: "ELE-ATV", tipoRelacao: "FS", defasagem: 3, origem: "R1: precedente explicito do legado" },
  { id: "REDE-004", predecessora: "ALV-ATV2", sucessora: "ESQ-ATV", tipoRelacao: "FS", defasagem: 3, origem: "R1: precedente explicito do legado" },
  { id: "REDE-005", predecessora: "FUN-ATV", sucessora: "EST-ATV1", tipoRelacao: "FS", defasagem: 3, origem: "R1: precedente explicito do legado" },
  { id: "REDE-006", predecessora: "EST-ATV1", sucessora: "EST-ATV2", tipoRelacao: "FS", defasagem: 3, origem: "R1: precedente explicito do legado" },
  { id: "REDE-007", predecessora: "EST-ATV2", sucessora: "EST-ATV3", tipoRelacao: "FS", defasagem: 3, origem: "R1: precedente explicito do legado" },
  { id: "REDE-008", predecessora: "LOC-ATV", sucessora: "FUN-ATV", tipoRelacao: "FS", defasagem: 3, origem: "R1: precedente explicito do legado" },
  { id: "REDE-009", predecessora: "EST-ATV2", sucessora: "HID-ATV", tipoRelacao: "FS", defasagem: 3, origem: "R1: precedente explicito do legado" },
  { id: "REDE-010", predecessora: "EST-ATV3", sucessora: "IMP-ATV", tipoRelacao: "FS", defasagem: 3, origem: "R1: precedente explicito do legado" },
  { id: "REDE-011", predecessora: "REV-ATV2", sucessora: "PIN-ATV", tipoRelacao: "FS", defasagem: 3, origem: "R1: precedente explicito do legado" },
  { id: "REDE-012", predecessora: "EST-ATV2", sucessora: "PLAN-001", tipoRelacao: "FS", defasagem: 59, origem: "R1-SUBST: precedente herdado pelo substituto" },
  { id: "REDE-013", predecessora: "HID-ATV", sucessora: "PLAN-002", tipoRelacao: "FS", defasagem: 3, origem: "R6: mesma EQUIPE_ID" },
  { id: "REDE-014", predecessora: "PLAN-001", sucessora: "PLAN-002", tipoRelacao: "FS", defasagem: 0, origem: "R1-ATIVO: PREDECESSORA_ID" },
  { id: "REDE-015", predecessora: "ELE-ATV", sucessora: "PLAN-003", tipoRelacao: "FS", defasagem: 24, origem: "R6: mesma EQUIPE_ID" },
  { id: "REDE-016", predecessora: "PLAN-002", sucessora: "PLAN-003", tipoRelacao: "FS", defasagem: 3, origem: "R1-ATIVO: PREDECESSORA_ID" },
  { id: "REDE-017", predecessora: "PLAN-001", sucessora: "REV-ATV1", tipoRelacao: "FS", defasagem: 0, origem: "R1: precedente explicito do legado" },
  { id: "REDE-018", predecessora: "ALV-ATV2", sucessora: "REV-ATV2", tipoRelacao: "FS", defasagem: 0, origem: "R1: precedente explicito do legado" },
];

/** 11 serviços da grade LOB ARES/Piemarta (aba LINHA DE BALANÇO). */
export const ARES_SERVICOS_LOB_REFERENCIA: string[] = [
  "Locação de obra",
  "Fundação",
  "Estrutura",
  "Alvenaria",
  "Revestimento interno",
  "Contrapiso",
  "Instalações elétricas",
  "Instalações hidráulicas",
  "Impermeabilização",
  "Pintura",
  "Esquadrias",
];

/** Duração total do cronograma de referência (dias) — derivada das atividades. */
export function aresDuracaoTotalReferencia(): number {
  if (ARES_ATIVIDADES_REFERENCIA.length === 0) return 0;
  const fim = new Date(ARES_ATIVIDADES_REFERENCIA[ARES_ATIVIDADES_REFERENCIA.length - 1].fim);
  const inicio = new Date(ARES_ATIVIDADES_REFERENCIA[0].inicio);
  return Math.round((fim.getTime() - inicio.getTime()) / 86400000);
}

/** Contagem de atividades por status no dataset de referência. */
export function aresResumoStatusReferencia(): Record<AresStatusAtividade, number> {
  const resumo: Record<AresStatusAtividade, number> = {
    concluido: 0,
    em_andamento: 0,
    planejado: 0,
    atrasado: 0,
  };
  for (const atv of ARES_ATIVIDADES_REFERENCIA) resumo[atv.status] += 1;
  return resumo;
}
