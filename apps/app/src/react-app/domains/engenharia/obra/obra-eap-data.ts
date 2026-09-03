// Domínio Engenharia — dados da EAP real da Obra Modelo EAP (FASE 06.2-B).
//
// FONTE DE ORIGEM (proveniência): arquivo oficial externo
//   C:\Users\Correta Engenharia\OBRAS-MODELO\OBRA-MODELO-EAP-001\data\eap\OBRA-MODELO-EAP-001-eap.json
//   (versão FASE-19.5, 81 nós, status PROPOSTA).
//
// Esta representação integrada passa a ser a FONTE OPERACIONAL da Obra dentro
// do OpenWork. O arquivo externo NÃO é lido em runtime; ele é apenas a origem
// desta migração. Nenhum campo foi descartado: todos os metadados e todos os
// campos de cada nó (wbs, nome, nivel, tipo, pai, fundamentacao, condicao) são
// preservados integralmente. A ordem dos nós é a ordem de ocorrência na fonte
// (pré-order), usada como `ordem` entre irmãos.
import type { ObraEap, ObraEapMetadata, ObraEapNode } from "./obra-eap-types";

export const OBRA_MODELO_EAP_ID = "OBRA-MODELO-EAP-001";

/** Nós da EAP real da Obra Modelo EAP (81 nós = 10/24/47). */
export const OBRA_MODELO_EAP_NODES: ObraEapNode[] = [
  // ---------------------------------------------------------------- //
  // 1 — Preparação, Projetos e Canteiro
  // ---------------------------------------------------------------- //
  { obraId: OBRA_MODELO_EAP_ID, wbs: "1", nome: "Preparação, Projetos e Canteiro", nivel: 1, tipo: "DISCIPLINA", pai: null, ordem: 1, fundamentacao: "Antecede a execução física; agrupa projetos, licenças e canteiro.", condicao: null },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "1.1", nome: "Projetos e Aprovações", nivel: 2, tipo: "PACOTE", pai: "1", ordem: 1, fundamentacao: "Reunião de projeto executivo e licenças como entregáveis de planejamento.", condicao: null },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "1.1.1", nome: "Projetos executivos", nivel: 3, tipo: "TRABALHO", pai: "1.1", ordem: 1, fundamentacao: "Base para execução e compatibilização.", condicao: null },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "1.1.2", nome: "Licenças e aprovações", nivel: 3, tipo: "TRABALHO", pai: "1.1", ordem: 2, fundamentacao: "Requisitos legais para início da obra.", condicao: null },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "1.2", nome: "Implantação do Canteiro", nivel: 2, tipo: "PACOTE", pai: "1", ordem: 2, fundamentacao: "Infraestrutura de apoio à execução.", condicao: null },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "1.2.1", nome: "Instalações provisórias", nivel: 3, tipo: "TRABALHO", pai: "1.2", ordem: 1, fundamentacao: "Alojamento, escritório e apoio administrativo.", condicao: null },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "1.2.2", nome: "Infraestrutura do canteiro", nivel: 3, tipo: "TRABALHO", pai: "1.2", ordem: 2, fundamentacao: "Acessos, energia, água e esgoto provisórios.", condicao: null },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "1.2.3", nome: "Mobilização", nivel: 3, tipo: "TRABALHO", pai: "1.2", ordem: 3, fundamentacao: "Chegada de equipamentos e equipes.", condicao: null },

  // ---------------------------------------------------------------- //
  // 2 — Infraestrutura e Fundações
  // ---------------------------------------------------------------- //
  { obraId: OBRA_MODELO_EAP_ID, wbs: "2", nome: "Infraestrutura e Fundações", nivel: 1, tipo: "DISCIPLINA", pai: null, ordem: 2, fundamentacao: "Suporte estrutural da edificação.", condicao: null },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "2.1", nome: "Escavações e Contenções", nivel: 2, tipo: "PACOTE", pai: "2", ordem: 1, fundamentacao: "Preparação do terreno para fundação. Sem subsolo (subsolos=0); escavação limitada à fundação.", condicao: null },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "2.1.1", nome: "Escavação", nivel: 3, tipo: "TRABALHO", pai: "2.1", ordem: 1, fundamentacao: "Cava para elementos de fundação (sem subsolo).", condicao: null },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "2.1.2", nome: "Contenções provisórias", nivel: 3, tipo: "TRABALHO", pai: "2.1", ordem: 2, fundamentacao: "Estabilidade das escavações; tipo depende de estudo geotécnico.", condicao: "HIPÓTESE / NECESSITA VALIDAÇÃO (tipo e necessidade)" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "2.2", nome: "Estruturas de Fundação", nivel: 2, tipo: "PACOTE", pai: "2", ordem: 2, fundamentacao: "Elementos que transferem cargas ao solo.", condicao: null },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "2.2.1", nome: "Elementos de fundação", nivel: 3, tipo: "TRABALHO", pai: "2.2", ordem: 1, fundamentacao: "Elementos de fundação (escopo genérico). A solução específica (sapatas/estacas/radier) depende de estudo geotécnico não informado.", condicao: "HIPÓTESE / NECESSITA VALIDAÇÃO (tipo de fundação)" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "2.2.2", nome: "Baldrame e cinta de fundação", nivel: 3, tipo: "TRABALHO", pai: "2.2", ordem: 2, fundamentacao: "Travamento entre elementos de fundação. A necessidade e o tipo dependem da solução de fundação (não definida).", condicao: "HIPÓTESE / NECESSITA VALIDAÇÃO (depende da solução de fundação)" },

  // ---------------------------------------------------------------- //
  // 3 — Superestrutura
  // ---------------------------------------------------------------- //
  { obraId: OBRA_MODELO_EAP_ID, wbs: "3", nome: "Superestrutura", nivel: 1, tipo: "DISCIPLINA", pai: null, ordem: 3, fundamentacao: "Estrutura portante vertical em concreto armado. Inclui pilotis, sobresolo, pavimentos tipo e cobertura.", condicao: null },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "3.1", nome: "Estrutura do Pilotis", nivel: 2, tipo: "PACOTE", pai: "3", ordem: 1, fundamentacao: "Nível térreo aberto com pilares. Caracterizado como presente.", condicao: "CONFIRMADO (pilotis)" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "3.1.1", nome: "Estrutura de pilares e laje do pilotis", nivel: 3, tipo: "TRABALHO", pai: "3.1", ordem: 1, fundamentacao: "Pilares do pilotis e laje de cobertura do nível de pilotis.", condicao: "CONFIRMADO (pilotis)" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "3.2", nome: "Estrutura do Sobresolo", nivel: 2, tipo: "PACOTE", pai: "3", ordem: 2, fundamentacao: "Nível acima do pilotis. Caracterizado como presente.", condicao: "CONFIRMADO (sobresolo)" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "3.2.1", nome: "Estrutura de pilares, vigas e laje do sobresolo", nivel: 3, tipo: "TRABALHO", pai: "3.2", ordem: 1, fundamentacao: "Estrutura do pavimento de sobresolo.", condicao: "CONFIRMADO (sobresolo)" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "3.3", nome: "Estrutura dos Pavimentos Tipo", nivel: 2, tipo: "PACOTE", pai: "3", ordem: 3, fundamentacao: "Estrutura dos pavimentos residenciais. 14 lajes no total; pavimentos tipo repetitivos (1 apto/andar).", condicao: null },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "3.3.1", nome: "Estrutura de pilares, vigas e lajes dos pavimentos residenciais", nivel: 3, tipo: "TRABALHO", pai: "3.3", ordem: 1, fundamentacao: "Estrutura dos pavimentos residenciais acima do sobresolo. 1 apto por andar favorece repetição.", condicao: null },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "3.4", nome: "Estrutura da Caixa de Escada e Elevador", nivel: 2, tipo: "PACOTE", pai: "3", ordem: 4, fundamentacao: "Núcleo rígido de verticalidade e acesso. A escada é componente típico; a caixa de elevador depende da existência do elevador (não confirmada).", condicao: "HIPÓTESE / NECESSITA VALIDAÇÃO (caixa de elevador depende da existência do elevador)" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "3.4.1", nome: "Estrutura da caixa de escada e elevador", nivel: 3, tipo: "TRABALHO", pai: "3.4", ordem: 1, fundamentacao: "Núcleo rígido, escada e shaft de elevador. A parcela relativa ao elevador é hipótese, pois a existência do elevador não está confirmada.", condicao: "HIPÓTESE / NECESSITA VALIDAÇÃO (parcela do elevador)" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "3.5", nome: "Estrutura do Reservatório Superior", nivel: 2, tipo: "PACOTE", pai: "3", ordem: 5, fundamentacao: "Apoio estrutural para reservatório de água na cobertura. A cobertura prevista NÃO comprova a existência de reservatório superior.", condicao: "HIPÓTESE / NECESSITA VALIDAÇÃO (existência de reservatório superior)" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "3.5.1", nome: "Estrutura do reservatório superior", nivel: 3, tipo: "TRABALHO", pai: "3.5", ordem: 1, fundamentacao: "Elemento estrutural para apoio do reservatório. Existência do reservatório é hipótese.", condicao: "HIPÓTESE / NECESSITA VALIDAÇÃO (existência de reservatório superior)" },

  // ---------------------------------------------------------------- //
  // 4 — Vedações e Esquadrias
  // ---------------------------------------------------------------- //
  { obraId: OBRA_MODELO_EAP_ID, wbs: "4", nome: "Vedações e Esquadrias", nivel: 1, tipo: "DISCIPLINA", pai: null, ordem: 4, fundamentacao: "Fechamentos verticais e aberturas.", condicao: null },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "4.1", nome: "Alvenarias", nivel: 2, tipo: "PACOTE", pai: "4", ordem: 1, fundamentacao: "Vedações internas e externas. O sistema de vedação não é determinado pela estrutura de concreto armado; alvenaria é hipótese provável.", condicao: "HIPÓTESE / NECESSITA VALIDAÇÃO (sistema de vedação)" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "4.1.1", nome: "Alvenaria interna", nivel: 3, tipo: "TRABALHO", pai: "4.1", ordem: 1, fundamentacao: "Divisórias internas das unidades e áreas comuns. Sistema de vedação é hipótese.", condicao: "HIPÓTESE / NECESSITA VALIDAÇÃO (sistema de vedação)" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "4.1.2", nome: "Alvenaria externa", nivel: 3, tipo: "TRABALHO", pai: "4.1", ordem: 2, fundamentacao: "Fechamento externo da edificação. Sistema de vedação é hipótese.", condicao: "HIPÓTESE / NECESSITA VALIDAÇÃO (sistema de vedação)" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "4.2", nome: "Esquadrias", nivel: 2, tipo: "PACOTE", pai: "4", ordem: 2, fundamentacao: "Janelas e portas.", condicao: "HIPÓTESE / NECESSITA VALIDAÇÃO (material/tipo)" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "4.2.1", nome: "Esquadrias de alumínio (janelas)", nivel: 3, tipo: "TRABALHO", pai: "4.2", ordem: 1, fundamentacao: "Esquadrias externas de referência.", condicao: "HIPÓTESE / NECESSITA VALIDAÇÃO" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "4.2.2", nome: "Portas internas e fechaduras", nivel: 3, tipo: "TRABALHO", pai: "4.2", ordem: 2, fundamentacao: "Portas internas das unidades.", condicao: null },

  // ---------------------------------------------------------------- //
  // 5 — Cobertura e Impermeabilização
  // ---------------------------------------------------------------- //
  { obraId: OBRA_MODELO_EAP_ID, wbs: "5", nome: "Cobertura e Impermeabilização", nivel: 1, tipo: "DISCIPLINA", pai: null, ordem: 5, fundamentacao: "Proteção superior e estanqueidade.", condicao: "Cobertura prevista" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "5.1", nome: "Cobertura", nivel: 2, tipo: "PACOTE", pai: "5", ordem: 1, fundamentacao: "Fechamento superior da edificação.", condicao: "Cobertura prevista" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "5.1.1", nome: "Estrutura e laje de cobertura", nivel: 3, tipo: "TRABALHO", pai: "5.1", ordem: 1, fundamentacao: "Suporte do sistema de cobertura.", condicao: "Cobertura prevista" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "5.1.2", nome: "Telhamento ou cobertura impermeabilizada", nivel: 3, tipo: "TRABALHO", pai: "5.1", ordem: 2, fundamentacao: "Sistema de vedação superior final.", condicao: "HIPÓTESE / NECESSITA VALIDAÇÃO (tipo de cobertura)" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "5.2", nome: "Impermeabilização", nivel: 2, tipo: "PACOTE", pai: "5", ordem: 2, fundamentacao: "Tratamento de áreas sob umidade.", condicao: null },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "5.2.1", nome: "Impermeabilização do sobresolo", nivel: 3, tipo: "TRABALHO", pai: "5.2", ordem: 1, fundamentacao: "Estanqueidade do sobresolo, se aplicável.", condicao: "HIPÓTESE / NECESSITA VALIDAÇÃO (sobresolo pode demandar impermeabilização)" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "5.2.2", nome: "Impermeabilização da cobertura", nivel: 3, tipo: "TRABALHO", pai: "5.2", ordem: 2, fundamentacao: "Estanqueidade da cobertura.", condicao: "Cobertura prevista" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "5.2.3", nome: "Impermeabilização de áreas molhadas", nivel: 3, tipo: "TRABALHO", pai: "5.2", ordem: 3, fundamentacao: "Banheiros, copas e áreas frias. A existência e localização de áreas molhadas não está confirmada na caracterização.", condicao: "HIPÓTESE / NECESSITA VALIDAÇÃO (existência de áreas molhadas)" },

  // ---------------------------------------------------------------- //
  // 6 — Instalações Prediais
  // ---------------------------------------------------------------- //
  { obraId: OBRA_MODELO_EAP_ID, wbs: "6", nome: "Instalações Prediais", nivel: 1, tipo: "DISCIPLINA", pai: null, ordem: 6, fundamentacao: "Infraestrutura de serviços da edificação.", condicao: null },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "6.1", nome: "Instalações Hidrossanitárias", nivel: 2, tipo: "PACOTE", pai: "6", ordem: 1, fundamentacao: "Água, esgoto e águas pluviais.", condicao: null },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "6.1.1", nome: "Água fria", nivel: 3, tipo: "TRABALHO", pai: "6.1", ordem: 1, fundamentacao: "Distribuição de água fria às unidades.", condicao: null },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "6.1.2", nome: "Esgoto e ventilação", nivel: 3, tipo: "TRABALHO", pai: "6.1", ordem: 2, fundamentacao: "Coleta e destinação de esgoto.", condicao: null },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "6.1.3", nome: "Águas pluviais", nivel: 3, tipo: "TRABALHO", pai: "6.1", ordem: 3, fundamentacao: "Captação e condução de águas de chuva.", condicao: null },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "6.1.4", nome: "Reservatórios de água", nivel: 3, tipo: "TRABALHO", pai: "6.1", ordem: 4, fundamentacao: "Reservação inferior/superior. A existência de reservatório superior é hipótese.", condicao: "HIPÓTESE / NECESSITA VALIDAÇÃO (reservatório superior)" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "6.1.5", nome: "Água quente", nivel: 3, tipo: "TRABALHO", pai: "6.1", ordem: 5, fundamentacao: "Distribuição de água quente. Existência não confirmada na caracterização.", condicao: "HIPÓTESE / NECESSITA VALIDAÇÃO (existência de água quente)" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "6.2", nome: "Instalações Elétricas", nivel: 2, tipo: "PACOTE", pai: "6", ordem: 2, fundamentacao: "Fornecimento e distribuição de energia.", condicao: null },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "6.2.1", nome: "Quadros e distribuição", nivel: 3, tipo: "TRABALHO", pai: "6.2", ordem: 1, fundamentacao: "Quadros, medidores e proteção por unidade.", condicao: null },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "6.2.2", nome: "Circuitos, pontos de luz e tomadas", nivel: 3, tipo: "TRABALHO", pai: "6.2", ordem: 2, fundamentacao: "Rede elétrica final das unidades.", condicao: null },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "6.3", nome: "Outros Sistemas Prediais", nivel: 2, tipo: "PACOTE", pai: "6", ordem: 3, fundamentacao: "Sistemas complementares.", condicao: null },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "6.3.1", nome: "Gás", nivel: 3, tipo: "TRABALHO", pai: "6.3", ordem: 1, fundamentacao: "Rede de gás, se prevista no projeto.", condicao: "HIPÓTESE / NECESSITA VALIDAÇÃO" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "6.3.2", nome: "Comunicação e dados", nivel: 3, tipo: "TRABALHO", pai: "6.3", ordem: 2, fundamentacao: "Infraestrutura de telecom/dados. Existência não confirmada na caracterização.", condicao: "HIPÓTESE / NECESSITA VALIDAÇÃO (existência de telecom/dados)" },

  // ---------------------------------------------------------------- //
  // 7 — Elevadores
  // ---------------------------------------------------------------- //
  { obraId: OBRA_MODELO_EAP_ID, wbs: "7", nome: "Elevadores", nivel: 1, tipo: "DISCIPLINA", pai: null, ordem: 7, fundamentacao: "Transporte vertical.", condicao: "HIPÓTESE / NECESSITA VALIDAÇÃO (necessário p/ 14 lajes; quantidade a validar)" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "7.1", nome: "Fornecimento e Instalação", nivel: 2, tipo: "PACOTE", pai: "7", ordem: 1, fundamentacao: "Aquisição e montagem do elevador.", condicao: "HIPÓTESE / NECESSITA VALIDAÇÃO" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "7.1.1", nome: "Fornecimento do elevador", nivel: 3, tipo: "TRABALHO", pai: "7.1", ordem: 1, fundamentacao: "Equipamento e componentes.", condicao: "HIPÓTESE / NECESSITA VALIDAÇÃO" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "7.1.2", nome: "Instalação e comissionamento", nivel: 3, tipo: "TRABALHO", pai: "7.1", ordem: 2, fundamentacao: "Montagem, testes e liberação.", condicao: "HIPÓTESE / NECESSITA VALIDAÇÃO" },

  // ---------------------------------------------------------------- //
  // 8 — Acabamentos
  // ---------------------------------------------------------------- //
  { obraId: OBRA_MODELO_EAP_ID, wbs: "8", nome: "Acabamentos", nivel: 1, tipo: "DISCIPLINA", pai: null, ordem: 8, fundamentacao: "Revestimentos e acabamento final.", condicao: null },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "8.1", nome: "Revestimentos", nivel: 2, tipo: "PACOTE", pai: "8", ordem: 1, fundamentacao: "Revestimento de pisos e paredes. Escopo provável de residencial; especificação não confirmada.", condicao: "HIPÓTESE / NECESSITA VALIDAÇÃO (especificação de acabamentos)" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "8.1.1", nome: "Revestimento de pisos", nivel: 3, tipo: "TRABALHO", pai: "8.1", ordem: 1, fundamentacao: "Piso das unidades e áreas comuns. Escopo provável; especificação não confirmada.", condicao: "HIPÓTESE / NECESSITA VALIDAÇÃO (especificação de acabamentos)" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "8.1.2", nome: "Revestimento de paredes", nivel: 3, tipo: "TRABALHO", pai: "8.1", ordem: 2, fundamentacao: "Revestimento de paredes internas/áreas molhadas. Escopo provável; especificação não confirmada.", condicao: "HIPÓTESE / NECESSITA VALIDAÇÃO (especificação de acabamentos)" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "8.2", nome: "Pintura", nivel: 2, tipo: "PACOTE", pai: "8", ordem: 2, fundamentacao: "Acabamento superficial.", condicao: "Pintura — usual em residencial; detalhe a validar" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "8.2.1", nome: "Pintura interna", nivel: 3, tipo: "TRABALHO", pai: "8.2", ordem: 1, fundamentacao: "Pintura de unidades e áreas internas.", condicao: null },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "8.2.2", nome: "Pintura externa", nivel: 3, tipo: "TRABALHO", pai: "8.2", ordem: 2, fundamentacao: "Pintura de fachada.", condicao: null },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "8.3", nome: "Forros e Acabamentos Diversos", nivel: 2, tipo: "PACOTE", pai: "8", ordem: 3, fundamentacao: "Forros e arremates. Escopo provável de residencial; especificação não confirmada.", condicao: "HIPÓTESE / NECESSITA VALIDAÇÃO (especificação de acabamentos)" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "8.3.1", nome: "Forros", nivel: 3, tipo: "TRABALHO", pai: "8.3", ordem: 1, fundamentacao: "Forros de áreas comuns e unidades. Escopo provável; especificação não confirmada.", condicao: "HIPÓTESE / NECESSITA VALIDAÇÃO (especificação de acabamentos)" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "8.3.2", nome: "Rodapés, soleiras e arremates", nivel: 3, tipo: "TRABALHO", pai: "8.3", ordem: 2, fundamentacao: "Acabamentos de fechamento. Escopo provável; especificação não confirmada.", condicao: "HIPÓTESE / NECESSITA VALIDAÇÃO (especificação de acabamentos)" },

  // ---------------------------------------------------------------- //
  // 9 — Sistemas de Proteção e Segurança
  // ---------------------------------------------------------------- //
  { obraId: OBRA_MODELO_EAP_ID, wbs: "9", nome: "Sistemas de Proteção e Segurança", nivel: 1, tipo: "DISCIPLINA", pai: null, ordem: 9, fundamentacao: "Proteção da edificação e ocupantes.", condicao: null },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "9.1", nome: "SPDA", nivel: 2, tipo: "PACOTE", pai: "9", ordem: 1, fundamentacao: "Proteção contra descargas atmosféricas.", condicao: "HIPÓTESE / NECESSITA VALIDAÇÃO" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "9.1.1", nome: "Sistema de proteção contra descargas atmosféricas", nivel: 3, tipo: "TRABALHO", pai: "9.1", ordem: 1, fundamentacao: "Captação, descida e aterramento.", condicao: "HIPÓTESE / NECESSITA VALIDAÇÃO" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "9.2", nome: "Segurança Contra Incêndio", nivel: 2, tipo: "PACOTE", pai: "9", ordem: 2, fundamentacao: "Proteção e resposta a incêndio.", condicao: "CONFIRMADO (existência mínima); HIPÓTESE/NECESSITA VALIDAÇÃO (escopo)" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "9.2.1", nome: "Sistema de combate a incêndio", nivel: 3, tipo: "TRABALHO", pai: "9.2", ordem: 1, fundamentacao: "Hidrantes/extintores/SPRINKLER conforme projeto.", condicao: "HIPÓTESE / NECESSITA VALIDAÇÃO (escopo)" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "9.2.2", nome: "Sinalização e iluminação de emergência", nivel: 3, tipo: "TRABALHO", pai: "9.2", ordem: 2, fundamentacao: "Rotas de fuga e sinalização.", condicao: "HIPÓTESE / NECESSITA VALIDAÇÃO (escopo)" },

  // ---------------------------------------------------------------- //
  // 10 — Áreas Externas
  // ---------------------------------------------------------------- //
  { obraId: OBRA_MODELO_EAP_ID, wbs: "10", nome: "Áreas Externas", nivel: 1, tipo: "DISCIPLINA", pai: null, ordem: 10, fundamentacao: "Urbanização e ligações externas.", condicao: "HIPÓTESE / NECESSITA VALIDAÇÃO (escopo)" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "10.1", nome: "Urbanização e Paisagismo", nivel: 2, tipo: "PACOTE", pai: "10", ordem: 1, fundamentacao: "Espaços externos do terreno.", condicao: "HIPÓTESE / NECESSITA VALIDAÇÃO" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "10.1.1", nome: "Pavimentação externa", nivel: 3, tipo: "TRABALHO", pai: "10.1", ordem: 1, fundamentacao: "Piso de áreas externas.", condicao: "HIPÓTESE / NECESSITA VALIDAÇÃO" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "10.1.2", nome: "Paisagismo", nivel: 3, tipo: "TRABALHO", pai: "10.1", ordem: 2, fundamentacao: "Áreas verdes e ajardinamento.", condicao: "HIPÓTESE / NECESSITA VALIDAÇÃO" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "10.2", nome: "Infraestrutura de Ligação", nivel: 2, tipo: "PACOTE", pai: "10", ordem: 2, fundamentacao: "Ligações de concessionárias e fechamentos.", condicao: "HIPÓTESE / NECESSITA VALIDAÇÃO" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "10.2.1", nome: "Ligações de água, esgoto e energia", nivel: 3, tipo: "TRABALHO", pai: "10.2", ordem: 1, fundamentacao: "Conexões externas de serviços.", condicao: "HIPÓTESE / NECESSITA VALIDAÇÃO" },
  { obraId: OBRA_MODELO_EAP_ID, wbs: "10.2.2", nome: "Muros e fechamentos externos", nivel: 3, tipo: "TRABALHO", pai: "10.2", ordem: 2, fundamentacao: "Divisas e fechamento do terreno.", condicao: "HIPÓTESE / NECESSITA VALIDAÇÃO" },
];

/** Metadados da EAP real da Obra Modelo EAP (preservados da fonte oficial). */
export const OBRA_MODELO_EAP_METADATA: ObraEapMetadata = {
  obraId: OBRA_MODELO_EAP_ID,
  obraNome: "Edifício Residencial Modelo EAP",
  status: "PROPOSTA",
  versao: "FASE-19.5",
  caracterizacaoRef: "data/caracterizacao/OBRA-MODELO-EAP-001.json",
  regraAlocacaoEstruturaCobertura:
    "A estrutura e laje de cobertura (5.1.1) é alocada na disciplina 5 (Cobertura e Impermeabilização), não na disciplina 3 (Superestrutura). Esta é a regra de alocação adotada para evitar ambiguidade e sobreposição semântica entre as disciplinas 3 e 5.",
  niveisTipos: { "1": "DISCIPLINA", "2": "PACOTE", "3": "TRABALHO" },
  principios: [
    "regra_100_porcento",
    "exclusividade_mutua",
    "orientacao_a_entregaveis",
    "decomposicao_progressiva",
    "work_packages",
    "rastreabilidade",
    "separacao_eap_do_cronograma",
  ],
  noTemplate:
    "Cronograma fora da EAP; sem duracao, predecessoras ou atividades de cronograma.",
  caracterizacaoResumo: {
    torres: 1,
    lajes: 14,
    pilotis: true,
    sobresolo: true,
    unidades_por_pavimento: 1,
    subsolos: 0,
    sistema_construtivo: "concreto_armado",
    cobertura_prevista: true,
  },
};

/** EAP completa da Obra Modelo EAP (metadados + nós). */
export const OBRA_MODELO_EAP: ObraEap = {
  obraId: OBRA_MODELO_EAP_ID,
  metadata: OBRA_MODELO_EAP_METADATA,
  nodes: OBRA_MODELO_EAP_NODES,
};
