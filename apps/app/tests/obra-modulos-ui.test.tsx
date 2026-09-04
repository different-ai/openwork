/** @jsxImportSource react */
import { beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ObraCaracterizacao } from "../src/react-app/domains/engenharia/obra/pages/obra-caracterizacao";
import { ObraDisciplinas } from "../src/react-app/domains/engenharia/obra/pages/obra-disciplinas";
import { ObraServicos } from "../src/react-app/domains/engenharia/obra/pages/obra-servicos";
import { OBRA_MODELO_EAP_ID } from "../src/react-app/domains/engenharia/obra/obra-eap-data";
import { resetObraEapRepository } from "../src/react-app/domains/engenharia/obra/obra-eap-repository";
import type { Obra } from "../src/react-app/domains/engenharia/obra/obra-types";

const OBRA_MODELO: Obra = {
  id: OBRA_MODELO_EAP_ID,
  nome: OBRA_MODELO_EAP_ID,
  status: "PROPOSTA",
  caracterizacao: {
    torres: 1,
    lajes: 14,
    apartamentosPorPavimento: 1,
    subsolos: 0,
    sistemaConstrutivo: "concreto_armado",
  },
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

describe("ObraCaracterizacao — módulo próprio (SSR)", () => {
  test("renderiza os campos estruturais da obra", () => {
    const html = renderToStaticMarkup(<ObraCaracterizacao obra={OBRA_MODELO} />);
    expect(html).toContain("Caracterização");
    expect(html).toContain("Torres");
    expect(html).toContain("Lajes");
    expect(html).toContain("Subsolos");
    expect(html).toContain("Sistema construtivo");
    expect(html).toContain("concreto_armado");
  });

  test("trata obra sem caracterização sem quebrar", () => {
    const semCarac: Obra = { id: "OBRA-X", nome: "X", status: "PROPOSTA" };
    const html = renderToStaticMarkup(<ObraCaracterizacao obra={semCarac} />);
    expect(html).toContain("ainda não preenchida");
  });
});

describe("ObraDisciplinas — 10 disciplinas derivadas (SSR)", () => {
  test("renderiza as 10 disciplinas com contagem de pacotes e trabalhos", () => {
    const html = renderToStaticMarkup(<ObraDisciplinas obra={OBRA_MODELO} />);
    expect(html).toContain("Disciplinas");
    expect(html).toContain("Preparação, Projetos e Canteiro");
    expect(html).toContain("Superestrutura");
    expect(html).toContain("Áreas Externas");
    expect(html).toContain("pacotes");
    expect(html).toContain("trabalhos");
  });

  test("trata obra sem EAP sem quebrar", () => {
    const semEap: Obra = { id: "OBRA-X", nome: "X", status: "PROPOSTA" };
    const html = renderToStaticMarkup(<ObraDisciplinas obra={semEap} />);
    expect(html).toContain("ainda não possui EAP definida");
  });
});

describe("ObraServicos — 47 trabalhos com datas e crítico (SSR)", () => {
  test("renderiza os trabalhos com duração, datas e caminho crítico", () => {
    const html = renderToStaticMarkup(<ObraServicos obra={OBRA_MODELO} />);
    expect(html).toContain("Serviços");
    expect(html).toContain("Escavação");
    expect(html).toContain("2026-01-05");
    expect(html).toContain("Crítico");
    expect(html).toContain("Sequencial");
  });

  test("trata obra sem EAP sem quebrar", () => {
    const semEap: Obra = { id: "OBRA-X", nome: "X", status: "PROPOSTA" };
    const html = renderToStaticMarkup(<ObraServicos obra={semEap} />);
    expect(html).toContain("Nenhum serviço para exibir");
  });
});
