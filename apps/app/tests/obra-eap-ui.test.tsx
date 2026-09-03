/** @jsxImportSource react */
import { beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ObraEap } from "../src/react-app/domains/engenharia/obra/pages/obra-eap";
import { EapTree } from "../src/react-app/domains/engenharia/obra/obra-eap-tree";
import { OBRA_MODELO_EAP_ID } from "../src/react-app/domains/engenharia/obra/obra-eap-data";
import {
  deriveEapRows,
  resetObraEapRepository,
} from "../src/react-app/domains/engenharia/obra/obra-eap-repository";
import type { Obra } from "../src/react-app/domains/engenharia/obra/obra-types";

const OBRA_MODELO: Obra = {
  id: OBRA_MODELO_EAP_ID,
  nome: OBRA_MODELO_EAP_ID,
  status: "PROPOSTA",
};

beforeEach(() => {
  const memory = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
    setItem: (key: string, value: string) => {
      memory.set(key, String(value));
    },
    removeItem: (key: string) => {
      memory.delete(key);
    },
    clear: () => memory.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
  resetObraEapRepository();
});

describe("ObraEap — página EAP real (SSR)", () => {
  test("renderiza o EAP real da Obra Modelo (81 nós, resumo derivado)", () => {
    const html = renderToStaticMarkup(<ObraEap obra={OBRA_MODELO} />);
    expect(html).toContain("EAP — Estrutura Analítica do Projeto");
    expect(html).toContain("Edifício Residencial Modelo EAP");
    expect(html).toContain("FASE-19.5");
    expect(html).toContain("data-eap-tree");
    // Resumo derivado dos nós reais
    expect(html).toContain("Total de nós");
    expect(html).toContain(">81<");
    expect(html).toContain(">10<");
    expect(html).toContain(">24<");
    expect(html).toContain(">47<");
    expect(html).toContain("Folhas");
    expect(html).toContain(">47<");
  });

  test("renderiza a árvore com WBS, nome e tipo dos nós reais", () => {
    const html = renderToStaticMarkup(<ObraEap obra={OBRA_MODELO} />);
    expect(html).toContain("Preparação, Projetos e Canteiro");
    expect(html).toContain("data-eap-row");
    expect(html).toContain('data-eap-wbs="1"');
    expect(html).toContain('data-eap-wbs="1.1.1"');
    expect(html).toContain("Disciplina");
    expect(html).toContain("Pacote");
    expect(html).toContain("Trabalho");
  });

  test("trata obra sem EAP sem quebrar", () => {
    const obraSemEap: Obra = { id: "OBRA-SEM-EAP", nome: "Sem EAP", status: "PROPOSTA" };
    const html = renderToStaticMarkup(<ObraEap obra={obraSemEap} />);
    expect(html).toContain("ainda não possui EAP definida");
  });
});

describe("EapTree — árvore navegável (SSR)", () => {
  test("renderiza linhas com WBS, nome e tipo", () => {
    const rows = deriveEapRows(
      [
        {
          obraId: OBRA_MODELO_EAP_ID,
          wbs: "1",
          nome: "Disciplina 1",
          nivel: 1,
          tipo: "DISCIPLINA" as const,
          pai: null,
          ordem: 1,
        },
        {
          obraId: OBRA_MODELO_EAP_ID,
          wbs: "1.1",
          nome: "Pacote 1.1",
          nivel: 2,
          tipo: "PACOTE" as const,
          pai: "1",
          ordem: 1,
        },
      ],
      new Set(),
    );
    const html = renderToStaticMarkup(
      <EapTree rows={rows} onSelect={() => {}} onToggle={() => {}} />,
    );
    expect(html).toContain("data-eap-tree");
    expect(html).toContain("Disciplina 1");
    expect(html).toContain("Pacote 1.1");
    expect(html).toContain('data-eap-wbs="1"');
    expect(html).toContain("Disciplina");
    expect(html).toContain("Pacote");
  });
});
