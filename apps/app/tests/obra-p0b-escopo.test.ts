import { describe, expect, test } from "bun:test";

import { OBRA_MODELO_EAP_ID, OBRA_MODELO_EAP_NODES } from "../src/react-app/domains/engenharia/obra/obra-eap-data";
import { getEscopo } from "../src/react-app/domains/engenharia/obra/obra-escopo-repository";
import {
  OBRA_SCOPE_REF,
  calcDuracao,
  derivarPlanejamentoCompleto,
  duracaoTotalDasLinhas,
} from "../src/react-app/domains/engenharia/obra/obra-planejamento-data";

const ESCOPO_MODELO = getEscopo(OBRA_MODELO_EAP_ID);

describe("P0b — repositório de escopo por obra (obra-escopo-repository)", () => {
  test("getEscopo(OBRA_MODELO_EAP_ID) tem paridade com OBRA_SCOPE_REF (WBS com quantidade>0)", () => {
    const comQtdRef = Object.values(OBRA_SCOPE_REF).filter((r) => r.quantidade > 0).length;
    const comQtdEscopo = Object.values(ESCOPO_MODELO).filter((e) => e.quantidade > 0).length;
    expect(comQtdEscopo).toBe(comQtdRef);
    expect(Object.keys(ESCOPO_MODELO).length).toBe(Object.keys(OBRA_SCOPE_REF).length);
  });

  test("getEscopo(OBRA_MODELO_EAP_ID) preserva unidade/quantidade/produtividade por WBS", () => {
    const escavacao = ESCOPO_MODELO["2.1.1"];
    expect(escavacao).toBeDefined();
    expect(escavacao.obraId).toBe(OBRA_MODELO_EAP_ID);
    expect(escavacao.wbs).toBe("2.1.1");
    expect(escavacao.unidade).toBe("m³");
    expect(escavacao.quantidade).toBe(120);
    expect(escavacao.produtividade).toBe("8 m³/dia");
  });

  test("getEscopo(OBRA-DEMO-001) retorna vazio (outra obra sem escopo)", () => {
    expect(getEscopo("OBRA-DEMO-001")).toEqual({});
  });
});

describe("P0b — calcDuracao parametrizado pelo escopo da obra", () => {
  test("com escopo da obra-modelo → mesmo valor que OBRA_SCOPE_REF (paridade)", () => {
    const escavacao = OBRA_MODELO_EAP_NODES.find((n) => n.wbs === "2.1.1")!;
    const ref = OBRA_SCOPE_REF["2.1.1"];
    const rate = Number(/([\d.]+)/.exec(ref.produtividade)![1]);
    expect(calcDuracao(escavacao, ESCOPO_MODELO)).toBe(Math.ceil(ref.quantidade / rate));
    expect(calcDuracao(escavacao, ESCOPO_MODELO)).toBe(15);
  });

  test("com escopo vazio → 0 (sem escopo, sem duração)", () => {
    const escavacao = OBRA_MODELO_EAP_NODES.find((n) => n.wbs === "2.1.1")!;
    expect(calcDuracao(escavacao, {})).toBe(0);
  });

  test("derivarPlanejamentoCompleto com escopo vazio → duração total 0", () => {
    const linhas = derivarPlanejamentoCompleto(OBRA_MODELO_EAP_NODES, {});
    expect(duracaoTotalDasLinhas(linhas)).toBe(0);
  });
});
