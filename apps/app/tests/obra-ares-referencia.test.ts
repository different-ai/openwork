import { describe, expect, test } from "bun:test";

import {
  ARES_ATIVIDADES_REFERENCIA,
  ARES_REDE_REFERENCIA,
  ARES_REFERENCIA,
  ARES_SERVICOS_LOB_REFERENCIA,
  aresDuracaoTotalReferencia,
  aresResumoStatusReferencia,
} from "../src/react-app/domains/engenharia/obra/obra-ares-referencia";
import { OBRA_MODELO_EAP_NODES } from "../src/react-app/domains/engenharia/obra/obra-eap-data";

describe("obra-ares-referencia — dataset de referência ARES/Piemarta (FASE 20.x)", () => {
  test("identifica o dataset como REFERÊNCIA, não como obra real", () => {
    expect(ARES_REFERENCIA.obra).toBe("Piemarta");
    expect(ARES_REFERENCIA.natureza).toContain("REFERÊNCIA");
    expect(ARES_REFERENCIA.natureza).toContain("NÃO é a obra real");
  });

  test("contém 15 atividades de cronograma com datas/predecessoras/%plan/%real/status", () => {
    expect(ARES_ATIVIDADES_REFERENCIA.length).toBe(15);
    for (const atv of ARES_ATIVIDADES_REFERENCIA) {
      expect(atv.inicio).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(atv.fim).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(atv.duracao).toBeGreaterThan(0);
      expect(atv.percentualPlan).toBeGreaterThanOrEqual(0);
      expect(atv.percentualPlan).toBeLessThanOrEqual(100);
      expect(atv.percentualReal).toBeGreaterThanOrEqual(0);
      expect(atv.percentualReal).toBeLessThanOrEqual(100);
    }
  });

  test("contém 18 elos de rede de precedências", () => {
    expect(ARES_REDE_REFERENCIA.length).toBe(18);
    for (const elo of ARES_REDE_REFERENCIA) {
      expect(elo.tipoRelacao).toBe("FS");
      expect(elo.defasagem).toBeGreaterThanOrEqual(0);
    }
  });

  test("contém 11 serviços na grade LOB", () => {
    expect(ARES_SERVICOS_LOB_REFERENCIA.length).toBe(11);
  });

  test("resumo de status soma 15 atividades", () => {
    const resumo = aresResumoStatusReferencia();
    const total = Object.values(resumo).reduce((a, b) => a + b, 0);
    expect(total).toBe(15);
    expect(resumo.concluido).toBe(5);
    expect(resumo.em_andamento).toBe(5);
    expect(resumo.planejado).toBe(4);
    expect(resumo.atrasado).toBe(1);
  });

  test("duração total do cronograma de referência é coerente (2026-01-05 → 2027-01-22)", () => {
    const dias = aresDuracaoTotalReferencia();
    expect(dias).toBeGreaterThan(300);
    expect(dias).toBeLessThan(400);
  });
});

describe("SEPARAÇÃO DE FONTES — obra real ≠ dataset ARES/Piemarta", () => {
  test("a EAP real tem 81 nós, NÃO os 85 da ARES", () => {
    expect(OBRA_MODELO_EAP_NODES.length).toBe(81);
    expect(OBRA_MODELO_EAP_NODES.length).not.toBe(85);
  });

  test("a EAP real tem 10 disciplinas raiz, NÃO as 20 da ARES", () => {
    const raizes = OBRA_MODELO_EAP_NODES.filter((n) => n.nivel === 1);
    expect(raizes.length).toBe(10);
    expect(raizes.length).not.toBe(20);
  });

  test("nenhuma atividade de referência usa WBS da EAP real (não há mistura)", () => {
    const wbsReais = new Set(OBRA_MODELO_EAP_NODES.map((n) => n.wbs));
    // As atividades de referência usam códigos próprios (LOC-ATV, FUN-ATV...),
    // nunca os WBS da EAP real (1, 1.1, 2.1.1...).
    for (const atv of ARES_ATIVIDADES_REFERENCIA) {
      expect(wbsReais.has(atv.codigo)).toBe(false);
    }
  });
});
