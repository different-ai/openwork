import { describe, expect, test } from "bun:test";

import { OBRA_MODELO_EAP_ID, OBRA_MODELO_EAP_NODES } from "../src/react-app/domains/engenharia/obra/obra-eap-data";
import { validateEap } from "../src/react-app/domains/engenharia/obra/obra-eap-repository";
import {
  DATA_INICIO_DEFAULT,
  dataInicioEfetiva,
  diaParaDataIso,
} from "../src/react-app/domains/engenharia/obra/obra-planejamento-data";

describe("P0a D8 — validateEap desacoplado da Obra Modelo", () => {
  test("valida EAP de outra obra (OBRA-DEMO-001) com todos os nós pertencentes a ela", () => {
    const nodes = OBRA_MODELO_EAP_NODES.map((n) => ({ ...n, obraId: "OBRA-DEMO-001" }));
    const result = validateEap(nodes, "OBRA-DEMO-001");
    expect(result.ok).toBe(true);
    expect(result.total).toBe(81);
    expect(result.foraDaObra).toEqual([]);
  });

  test("marca como foraDaObra nó de obra diferente da validada", () => {
    const nodes = OBRA_MODELO_EAP_NODES.map((n) =>
      n.wbs === "2.1.1" ? { ...n, obraId: "OBRA-DEMO-001" } : n,
    );
    const result = validateEap(nodes, OBRA_MODELO_EAP_ID);
    expect(result.ok).toBe(false);
    expect(result.foraDaObra).toEqual(["2.1.1"]);
  });

  test("obra-modelo continua válida via seed (todos os nós pertencem a ela)", () => {
    const result = validateEap(OBRA_MODELO_EAP_NODES, OBRA_MODELO_EAP_ID);
    expect(result.ok).toBe(true);
    expect(result.foraDaObra).toEqual([]);
  });
});

describe("P0a D9 — dataInicioEfetiva vincula o cronograma à obra", () => {
  test("dataInicioEfetiva('2026-06-01') retorna 01/06/2026", () => {
    const d = dataInicioEfetiva("2026-06-01");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(5);
    expect(d.getDate()).toBe(1);
  });

  test("dataInicioEfetiva(null) cai no fallback 05/01/2026", () => {
    const d = dataInicioEfetiva(null);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(5);
  });

  test("dataInicioEfetiva(undefined) cai no fallback 05/01/2026", () => {
    const d = dataInicioEfetiva(undefined);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(5);
  });

  test("DATA_INICIO_DEFAULT é 05/01/2026 (preserva a seed da obra-modelo)", () => {
    expect(DATA_INICIO_DEFAULT.getFullYear()).toBe(2026);
    expect(DATA_INICIO_DEFAULT.getMonth()).toBe(0);
    expect(DATA_INICIO_DEFAULT.getDate()).toBe(5);
  });

  test("diaParaDataIso respeita a data de início efetiva da obra", () => {
    expect(diaParaDataIso(0, dataInicioEfetiva("2026-06-01"))).toBe("2026-06-01");
    expect(diaParaDataIso(0, dataInicioEfetiva(null))).toBe("2026-01-05");
  });
});
