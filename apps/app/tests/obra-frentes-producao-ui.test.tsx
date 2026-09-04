/** @jsxImportSource react */
import { beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ObraFrentes } from "../src/react-app/domains/engenharia/obra/pages/obra-frentes";
import { ObraProducao } from "../src/react-app/domains/engenharia/obra/pages/obra-producao";
import { OBRA_MODELO_EAP_ID } from "../src/react-app/domains/engenharia/obra/obra-eap-data";
import { resetObraEapRepository } from "../src/react-app/domains/engenharia/obra/obra-eap-repository";
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

describe("ObraFrentes — frentes derivadas da EAP real (SSR)", () => {
  test("renderiza as 10 frentes (disciplinas raiz) com contagem", () => {
    const html = renderToStaticMarkup(<ObraFrentes obra={OBRA_MODELO} />);
    expect(html).toContain("Frentes de Serviço");
    expect(html).toContain("Preparação, Projetos e Canteiro");
    expect(html).toContain("Superestrutura");
    expect(html).toContain("Áreas Externas");
    expect(html).toContain("Pacotes");
    expect(html).toContain("Trabalhos");
  });

  test("trata obra sem EAP sem quebrar", () => {
    const semEap: Obra = { id: "OBRA-X", nome: "X", status: "PROPOSTA" };
    const html = renderToStaticMarkup(<ObraFrentes obra={semEap} />);
    expect(html).toContain("ainda não possui EAP definida");
  });
});

describe("ObraProducao — produção derivada do cronograma real (SSR)", () => {
  test("renderiza os trabalhos com quantidade planejada e ritmo", () => {
    const html = renderToStaticMarkup(<ObraProducao obra={OBRA_MODELO} />);
    expect(html).toContain("Produção");
    expect(html).toContain("Escavação");
    expect(html).toContain("Qtd. planejada");
    expect(html).toContain("Ritmo");
    expect(html).toContain("Pendente");
  });

  test("trata obra sem EAP sem quebrar", () => {
    const semEap: Obra = { id: "OBRA-X", nome: "X", status: "PROPOSTA" };
    const html = renderToStaticMarkup(<ObraProducao obra={semEap} />);
    expect(html).toContain("ainda não possui EAP definida");
  });
});
