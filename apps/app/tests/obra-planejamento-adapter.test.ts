import { describe, expect, test } from "bun:test";

import { OBRA_MODELO_EAP_ID, OBRA_MODELO_EAP_NODES } from "../src/react-app/domains/engenharia/obra/obra-eap-data";
import { getEscopo } from "../src/react-app/domains/engenharia/obra/obra-escopo-repository";
import {
  DATA_INICIO_OBRA,
  calcDuracao,
  derivarPlanejamentoCompleto,
  diaParaDataIso,
  duracaoTotalDasLinhas,
  limiarCriticoDasLinhas,
  resolveDisciplina,
} from "../src/react-app/domains/engenharia/obra/obra-planejamento-data";
import {
  eapNodeParaPlanningItem,
  obraEapParaPlanningDashboard,
} from "../src/react-app/domains/engenharia/obra/obra-planejamento-adapter";
import { derivePlanningRows } from "../src/react-app/domains/planejamento/planning-data";

const ESCOPO_MODELO = getEscopo(OBRA_MODELO_EAP_ID);

describe("obra-planejamento-data — derivação do cronograma (FASE 20.x)", () => {
  test("duração total da obra é 698 dias (início 05/01/2026)", () => {
    const linhas = derivarPlanejamentoCompleto(OBRA_MODELO_EAP_NODES, ESCOPO_MODELO);
    expect(duracaoTotalDasLinhas(linhas)).toBe(698);
    expect(DATA_INICIO_OBRA.getFullYear()).toBe(2026);
    expect(DATA_INICIO_OBRA.getMonth()).toBe(0);
    expect(DATA_INICIO_OBRA.getDate()).toBe(5);
  });

  test("34 trabalhos têm duração estimada; 47 nós sem duração", () => {
    const linhas = derivarPlanejamentoCompleto(OBRA_MODELO_EAP_NODES, ESCOPO_MODELO);
    const comDuracao = linhas.filter((l) => l.duracao > 0).length;
    const semDuracao = linhas.filter((l) => l.duracao === 0).length;
    expect(comDuracao).toBe(34);
    expect(semDuracao).toBe(47);
  });

  test("limiar crítico é 45 dias (60% da maior duração)", () => {
    const linhas = derivarPlanejamentoCompleto(OBRA_MODELO_EAP_NODES, ESCOPO_MODELO);
    expect(limiarCriticoDasLinhas(linhas)).toBe(45);
  });

  test("6 trabalhos são CRÍTICOS", () => {
    const linhas = derivarPlanejamentoCompleto(OBRA_MODELO_EAP_NODES, ESCOPO_MODELO);
    const criticos = linhas.filter((l) => l.critico === "CRÍTICO").length;
    expect(criticos).toBe(6);
  });

  test("Escavação (2.1.1) dura 15 dias e ocupa as semanas 1–3", () => {
    const linhas = derivarPlanejamentoCompleto(OBRA_MODELO_EAP_NODES, ESCOPO_MODELO);
    const escavacao = linhas.find((l) => l.node.wbs === "2.1.1");
    expect(escavacao?.duracao).toBe(15);
    expect(escavacao?.inicio).toBe(0);
    expect(escavacao?.fim).toBe(15);
    // Semana 1 = dias 0..6, semana 2 = 7..13, semana 3 = 14..20
    expect(escavacao?.fim).toBeGreaterThan(13);
  });

  test("predecessora encadeia os trabalhos com duração", () => {
    const linhas = derivarPlanejamentoCompleto(OBRA_MODELO_EAP_NODES, ESCOPO_MODELO);
    const trabalhos = linhas.filter((l) => l.node.tipo === "TRABALHO" && l.duracao > 0);
    for (let i = 1; i < trabalhos.length; i += 1) {
      expect(trabalhos[i].predecessora).toBe(trabalhos[i - 1].node.wbs);
    }
  });

  test("resolveDisciplina devolve o nome da disciplina raiz", () => {
    const n211 = OBRA_MODELO_EAP_NODES.find((n) => n.wbs === "2.1.1");
    expect(resolveDisciplina(n211!, OBRA_MODELO_EAP_NODES)).toBe(
      "Infraestrutura e Fundações",
    );
  });

  test("diaParaDataIso converte dia acumulado em data ISO", () => {
    expect(diaParaDataIso(0)).toBe("2026-01-05");
    expect(diaParaDataIso(698)).toBe("2027-12-04");
  });

  test("calcDuracao usa quantidade/produtividade (ceil)", () => {
    const escavacao = OBRA_MODELO_EAP_NODES.find((n) => n.wbs === "2.1.1");
    expect(calcDuracao(escavacao!, ESCOPO_MODELO)).toBe(15); // 120 / 8
    const disciplina = OBRA_MODELO_EAP_NODES.find((n) => n.wbs === "2");
    expect(calcDuracao(disciplina!, ESCOPO_MODELO)).toBe(0); // não é TRABALHO
  });
});

describe("obra-planejamento-adapter — EAP → PlanningDashboardData", () => {
  test("produz 81 itens com hierarquia preservada", () => {
    const data = obraEapParaPlanningDashboard(OBRA_MODELO_EAP_NODES, "Obra Modelo EAP", ESCOPO_MODELO);
    expect(data.items.length).toBe(81);
    const rows = derivePlanningRows(data.items, new Set());
    expect(rows.length).toBe(81);
    // Raiz primeiro, filho depois (pré-order)
    const order = rows.map((r) => r.item.id);
    expect(order.indexOf("1")).toBeLessThan(order.indexOf("1.1"));
    expect(order.indexOf("1.1")).toBeLessThan(order.indexOf("1.1.1"));
  });

  test("níveis mapeados: EAP nivel 1 → planning level 0", () => {
    const data = obraEapParaPlanningDashboard(OBRA_MODELO_EAP_NODES, "Obra Modelo EAP", ESCOPO_MODELO);
    const raiz = data.items.find((i) => i.id === "1");
    const trabalho = data.items.find((i) => i.id === "2.1.1");
    expect(raiz?.level).toBe(0);
    expect(trabalho?.level).toBe(2);
  });

  test("trabalhos com duração têm datas; demais não", () => {
    const data = obraEapParaPlanningDashboard(OBRA_MODELO_EAP_NODES, "Obra Modelo EAP", ESCOPO_MODELO);
    const escavacao = data.items.find((i) => i.id === "2.1.1");
    expect(escavacao?.start).toBe("2026-01-05");
    expect(escavacao?.end).toBe("2026-01-20");
    const disciplina = data.items.find((i) => i.id === "2");
    expect(disciplina?.start).toBeNull();
    expect(disciplina?.end).toBeNull();
  });

  test("contexto reflete a obra e a fonte (81 nós)", () => {
    const data = obraEapParaPlanningDashboard(OBRA_MODELO_EAP_NODES, "Edifício Modelo", ESCOPO_MODELO);
    expect(data.context.title).toBe("Planejamento");
    expect(data.context.subtitle).toContain("Edifício Modelo");
    expect(data.context.subtitle).toContain("81 nós");
  });

  test("eapNodeParaPlanningItem mapeia campos individualmente", () => {
    const node = OBRA_MODELO_EAP_NODES.find((n) => n.wbs === "2.1.1")!;
    const item = eapNodeParaPlanningItem(node, "2026-01-05", "2026-01-20");
    expect(item.id).toBe("2.1.1");
    expect(item.parentId).toBe("2.1");
    expect(item.name).toBe("Escavação");
    expect(item.status).toBe("planejado");
    expect(item.progress).toBe(0);
  });
});
