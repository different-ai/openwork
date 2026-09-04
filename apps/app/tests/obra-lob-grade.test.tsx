/** @jsxImportSource react */
import { beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  OBRA_MODELO_EAP_ID,
  OBRA_MODELO_EAP_NODES,
} from "../src/react-app/domains/engenharia/obra/obra-eap-data";
import { resetObraEapRepository } from "../src/react-app/domains/engenharia/obra/obra-eap-repository";
import { getEscopo } from "../src/react-app/domains/engenharia/obra/obra-escopo-repository";
import {
  derivarGradeLob,
  gerarSemanas,
  linhaParaLobLinha,
} from "../src/react-app/domains/engenharia/obra/obra-lob-data";
import { derivarPlanejamentoCompleto } from "../src/react-app/domains/engenharia/obra/obra-planejamento-data";
import { ObraLobGrade } from "../src/react-app/domains/engenharia/obra/pages/obra-lob-grade";
import type { Obra } from "../src/react-app/domains/engenharia/obra/obra-types";

const ESCOPO_MODELO = getEscopo(OBRA_MODELO_EAP_ID);

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

describe("obra-lob-data — grade Linha de Balanço (FASE 20.x)", () => {
  test("gera 100 semanas cobrindo a obra (05/01/2026 → 04/12/2027)", () => {
    const semanas = gerarSemanas(698);
    expect(semanas.length).toBe(100);
    expect(semanas[0].inicio).toBe("2026-01-05");
    expect(semanas[0].fim).toBe("2026-01-11");
    expect(semanas[99].inicio).toBe("2027-11-29");
    expect(semanas[99].fim).toBe("2027-12-05");
  });

  test("grade deriva 34 serviços com duração e 6 críticos", () => {
    const { semanas, linhas } = derivarGradeLob(
      // usa os nós reais via repositório? Não — usa a fonte direta.
      // Importamos os nós reais abaixo.
      OBRA_MODELO_EAP_NODES,
      ESCOPO_MODELO,
    );
    expect(semanas.length).toBe(100);
    expect(linhas.length).toBe(34);
    expect(linhas.filter((l) => l.critico === "CRÍTICO").length).toBe(6);
  });

  test("Escavação (2.1.1) ativa nas semanas 1–3 (dias 0–15)", () => {
    const linhas = derivarPlanejamentoCompleto(OBRA_MODELO_EAP_NODES, ESCOPO_MODELO);
    const escavacao = linhas.find((l) => l.node.wbs === "2.1.1")!;
    const lob = linhaParaLobLinha(escavacao);
    expect(lob.semanasAtivas).toEqual([0, 1, 2]);
  });

  test("serviço sem duração não entra na grade", () => {
    const linhas = derivarPlanejamentoCompleto(OBRA_MODELO_EAP_NODES, ESCOPO_MODELO);
    const disciplina = linhas.find((l) => l.node.wbs === "2")!;
    const lob = linhaParaLobLinha(disciplina);
    expect(lob.duracao).toBe(0);
    expect(lob.semanasAtivas).toEqual([]);
  });
});

describe("ObraLobGrade — grade LOB (SSR)", () => {
  test("renderiza semanas, serviços e células ativas", () => {
    const html = renderToStaticMarkup(<ObraLobGrade obra={OBRA_MODELO} />);
    expect(html).toContain("Linha de Balanço");
    expect(html).toContain("100 semanas");
    expect(html).toContain("34 serviços");
    expect(html).toContain("6 críticos");
    expect(html).toContain("Escavação");
    expect(html).toContain("SEM");
  });

  test("trata obra sem EAP sem quebrar", () => {
    const semEap: Obra = { id: "OBRA-X", nome: "X", status: "PROPOSTA" };
    const html = renderToStaticMarkup(<ObraLobGrade obra={semEap} />);
    expect(html).toContain("ainda não possui EAP definida");
  });
});
