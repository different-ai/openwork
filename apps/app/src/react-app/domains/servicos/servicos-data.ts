// Helpers puros da capacidade de Serviços — sem DOM, testáveis.
// Tudo aqui é DERIVADO dos dados fornecidos pelo adapter; nada é inventado.
// FASE 21: contrato preparado para a FASE 22 (orçamento, medição, indicadores).
import type { ServicosData, ServicosSummary } from "./servicos-types";

/** Deriva o resumo (KPIs) a partir dos itens reais. */
export function deriveServicosSummary(data: ServicosData): ServicosSummary {
  let criticos = 0;
  let sequenciais = 0;
  let comDuracao = 0;
  for (const item of data.items) {
    if (item.status === "CRÍTICO") criticos += 1;
    else if (item.status === "Sequencial") sequenciais += 1;
    if (item.duracao > 0) comDuracao += 1;
  }
  return {
    total: data.items.length,
    criticos,
    sequenciais,
    comDuracao,
  };
}
