import { describe, expect, test } from "bun:test";

import {
  OBRA_MODELO_EAP,
  OBRA_MODELO_EAP_ID,
  OBRA_MODELO_EAP_METADATA,
  OBRA_MODELO_EAP_NODES,
} from "../src/react-app/domains/engenharia/obra/obra-eap-data";
import {
  EAP_REFERENCES,
  REF_EAP_RES_001,
  findEapReference,
  resolveReferenceNodes,
} from "../src/react-app/domains/engenharia/obra/obra-eap-reference";
import {
  countEapLeaves,
  deriveEapRows,
  deriveEapSummary,
  eapRootWbs,
  getEapForObra,
  getEapNodesForObra,
  getEapSummaryForObra,
  validateEap,
} from "../src/react-app/domains/engenharia/obra/obra-eap-repository";

describe("EAP real da Obra Modelo — fonte × destino (FASE 06.2-B)", () => {
  test("81 nós preservados (10 DISCIPLINA / 24 PACOTE / 47 TRABALHO)", () => {
    const nodes = OBRA_MODELO_EAP_NODES;
    expect(nodes.length).toBe(81);
    const disciplinas = nodes.filter((n) => n.tipo === "DISCIPLINA").length;
    const pacotes = nodes.filter((n) => n.tipo === "PACOTE").length;
    const trabalhos = nodes.filter((n) => n.tipo === "TRABALHO").length;
    expect(disciplinas).toBe(10);
    expect(pacotes).toBe(24);
    expect(trabalhos).toBe(47);
  });

  test("10 raízes e 47 folhas", () => {
    expect(eapRootWbs(OBRA_MODELO_EAP_NODES).length).toBe(10);
    expect(countEapLeaves(OBRA_MODELO_EAP_NODES)).toBe(47);
  });

  test("todos os nós pertencem a OBRA-MODELO-EAP-001", () => {
    for (const node of OBRA_MODELO_EAP_NODES) {
      expect(node.obraId).toBe(OBRA_MODELO_EAP_ID);
    }
  });

  test("WBS preservados no formato hierárquico (1, 1.1, 1.1.1)", () => {
    const wbs = OBRA_MODELO_EAP_NODES.map((n) => n.wbs);
    expect(wbs).toContain("1");
    expect(wbs).toContain("1.1");
    expect(wbs).toContain("1.1.1");
    expect(wbs).toContain("10.2.2");
  });

  test("nomes, tipos, fundamentação e condição preservados", () => {
    const n1 = OBRA_MODELO_EAP_NODES.find((n) => n.wbs === "1");
    expect(n1?.nome).toBe("Preparação, Projetos e Canteiro");
    expect(n1?.tipo).toBe("DISCIPLINA");
    expect(n1?.nivel).toBe(1);
    expect(n1?.pai).toBeNull();
    expect(n1?.fundamentacao).toContain("Antecede a execução física");

    const n211 = OBRA_MODELO_EAP_NODES.find((n) => n.wbs === "2.1.1");
    expect(n211?.nome).toBe("Escavação");
    expect(n211?.tipo).toBe("TRABALHO");
    expect(n211?.pai).toBe("2.1");

    const n212 = OBRA_MODELO_EAP_NODES.find((n) => n.wbs === "2.1.2");
    expect(n212?.condicao).toContain("HIPÓTESE");
  });

  test("ordem entre irmãos preservada (ordem declarada da fonte)", () => {
    const filhosDe1 = OBRA_MODELO_EAP_NODES.filter((n) => n.pai === "1");
    expect(filhosDe1.map((n) => n.wbs)).toEqual(["1.1", "1.2"]);
    expect(filhosDe1.map((n) => n.ordem)).toEqual([1, 2]);
  });

  test("metadados preservados (versão FASE-19.5, status PROPOSTA)", () => {
    expect(OBRA_MODELO_EAP_METADATA.versao).toBe("FASE-19.5");
    expect(OBRA_MODELO_EAP_METADATA.status).toBe("PROPOSTA");
    expect(OBRA_MODELO_EAP_METADATA.obraNome).toBe("Edifício Residencial Modelo EAP");
    expect(OBRA_MODELO_EAP_METADATA.niveisTipos).toEqual({
      "1": "DISCIPLINA",
      "2": "PACOTE",
      "3": "TRABALHO",
    });
    expect(OBRA_MODELO_EAP_METADATA.principios).toContain("regra_100_porcento");
    expect(OBRA_MODELO_EAP_METADATA.regraAlocacaoEstruturaCobertura).toContain("5.1.1");
  });
});

describe("EAP — integridade estrutural", () => {
  test("nenhum WBS duplicado, pai inexistente, raiz com pai ou ciclo", () => {
    const result = validateEap(OBRA_MODELO_EAP_NODES, OBRA_MODELO_EAP_ID);
    expect(result.ok).toBe(true);
    expect(result.total).toBe(81);
    expect(result.wbsDuplicados).toEqual([]);
    expect(result.paisInexistentes).toEqual([]);
    expect(result.raizesComPai).toEqual([]);
    expect(result.ciclos).toEqual([]);
    expect(result.foraDaObra).toEqual([]);
  });

  test("validação detecta WBS duplicado", () => {
    const nodes = [
      ...OBRA_MODELO_EAP_NODES.slice(0, 2),
      { ...OBRA_MODELO_EAP_NODES[1] },
    ];
    const result = validateEap(nodes, OBRA_MODELO_EAP_ID);
    expect(result.ok).toBe(false);
    expect(result.wbsDuplicados).toContain("1.1");
  });

  test("validação detecta pai inexistente", () => {
    const nodes = OBRA_MODELO_EAP_NODES.map((n) =>
      n.wbs === "1.1.1" ? { ...n, pai: "99.99" } : n,
    );
    const result = validateEap(nodes, OBRA_MODELO_EAP_ID);
    expect(result.ok).toBe(false);
    expect(result.paisInexistentes).toContain("1.1.1");
  });
});

describe("EAP — resumo derivado dos nós reais", () => {
  test("deriveEapSummary produz 81/10/24/47 a partir dos nós", () => {
    const summary = deriveEapSummary(OBRA_MODELO_EAP_NODES);
    expect(summary.total).toBe(81);
    expect(summary.raizes).toBe(10);
    expect(summary.pacotes).toBe(24);
    expect(summary.trabalhos).toBe(47);
    expect(summary.status).toBe("PROPOSTA");
  });

  test("getEapSummaryForObra deriva do repositório por obraId", () => {
    const summary = getEapSummaryForObra(OBRA_MODELO_EAP_ID);
    expect(summary?.total).toBe(81);
    expect(getEapSummaryForObra("OBRA-NAO-EXISTE")).toBeNull();
  });

  test("getEapForObra / getEapNodesForObra resolvem por obraId", () => {
    expect(getEapForObra(OBRA_MODELO_EAP_ID)?.nodes.length).toBe(81);
    expect(getEapNodesForObra(OBRA_MODELO_EAP_ID).length).toBe(81);
    expect(getEapNodesForObra("OBRA-NAO-EXISTE")).toEqual([]);
  });
});

describe("EAP — árvore derivada (deriveEapRows)", () => {
  test("pré-order: pai antes do filho, ordem entre irmãos preservada", () => {
    const rows = deriveEapRows(OBRA_MODELO_EAP_NODES, new Set());
    const order = rows.map((r) => r.node.wbs);
    expect(order.indexOf("1")).toBeLessThan(order.indexOf("1.1"));
    expect(order.indexOf("1.1")).toBeLessThan(order.indexOf("1.1.1"));
    expect(order.indexOf("1.1.1")).toBeLessThan(order.indexOf("1.1.2"));
    expect(order.indexOf("1.1.2")).toBeLessThan(order.indexOf("1.2"));
    expect(rows.find((r) => r.node.wbs === "1")?.depth).toBe(0);
    expect(rows.find((r) => r.node.wbs === "1.1.1")?.depth).toBe(2);
  });

  test("recolher um nó oculta descendentes e expandir restaura", () => {
    const collapsed = deriveEapRows(OBRA_MODELO_EAP_NODES, new Set(["1"]));
    const ids = collapsed.map((r) => r.node.wbs);
    expect(ids).toContain("1");
    expect(ids).not.toContain("1.1");
    const expanded = deriveEapRows(OBRA_MODELO_EAP_NODES, new Set());
    expect(expanded.map((r) => r.node.wbs)).toContain("1.1");
  });

  test("todas as 81 linhas são produzidas quando nada está recolhido", () => {
    const rows = deriveEapRows(OBRA_MODELO_EAP_NODES, new Set());
    expect(rows.length).toBe(81);
  });
});

describe("EAP — referência reutilizável (EapReference)", () => {
  test("REF-EAP-RES-001 registrada com origem e versão corretas", () => {
    expect(REF_EAP_RES_001.id).toBe("REF-EAP-RES-001");
    expect(REF_EAP_RES_001.nome).toBe("EAP Residencial Completo");
    expect(REF_EAP_RES_001.origem).toBe("Obra Modelo EAP");
    expect(REF_EAP_RES_001.versaoOrigem).toBe("FASE-19.5");
    expect(REF_EAP_RES_001.origemObraId).toBe(OBRA_MODELO_EAP_ID);
  });

  test("catálogo contém a primeira referência", () => {
    expect(EAP_REFERENCES.map((r) => r.id)).toContain("REF-EAP-RES-001");
    expect(findEapReference("REF-EAP-RES-001")?.nome).toBe("EAP Residencial Completo");
    expect(findEapReference("NAO-EXISTE")).toBeUndefined();
  });

  test("referência resolve os 81 nós da origem por identidade (sem duplicar)", () => {
    const nodes = resolveReferenceNodes(REF_EAP_RES_001);
    expect(nodes.length).toBe(81);
    // A referência não embute os nós: aponta para a EAP operacional da origem.
    expect("nodes" in REF_EAP_RES_001).toBe(false);
  });

  test("EAP completa exposta pelo repositório é a mesma da referência", () => {
    expect(OBRA_MODELO_EAP.nodes.length).toBe(81);
    expect(OBRA_MODELO_EAP.obraId).toBe(OBRA_MODELO_EAP_ID);
  });
});
