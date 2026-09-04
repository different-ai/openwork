/** @jsxImportSource react */
import { beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { ObraShellRoute } from "../src/react-app/domains/engenharia/obra/obra-shell-route";
import { OBRA_MODELO_EAP_ID } from "../src/react-app/domains/engenharia/obra/obra-eap-data";
import { resetObraEapRepository } from "../src/react-app/domains/engenharia/obra/obra-eap-repository";
import { resetObraRepository } from "../src/react-app/domains/engenharia/obra/obra-repository";
import { useObraStore } from "../src/react-app/domains/engenharia/obra/obra-store";

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
  resetObraRepository();
  resetObraEapRepository();
  useObraStore.setState({ selectedModules: {} });
});

function renderShell(modulo?: string) {
  return renderToStaticMarkup(
    <MemoryRouter
      initialEntries={[
        `/dominios/engenharia/obras/${OBRA_MODELO_EAP_ID}${modulo ? `/${modulo}` : ""}`,
      ]}
    >
      <ObraShellRoute obraId={OBRA_MODELO_EAP_ID} modulo={(modulo as never) ?? null} />
    </MemoryRouter>,
  );
}

describe("ObraShellRoute — Tabs por fase com subitens (FASE 21)", () => {
  test("renderiza as três fases (Preparação, Execução, Suporte)", () => {
    const html = renderShell();
    expect(html).toContain("data-obra-fases");
    expect(html).toContain('data-obra-fase="preparacao"');
    expect(html).toContain('data-obra-fase="execucao"');
    expect(html).toContain('data-obra-fase="suporte"');
    expect(html).toContain("Preparação");
    expect(html).toContain("Execução");
    expect(html).toContain("Suporte");
  });

  test("fase Preparação ativa por padrão mostra seus subitens", () => {
    const html = renderShell();
    expect(html).toContain("data-obra-modulos");
    expect(html).toContain('data-obra-module="visao-geral"');
    expect(html).toContain('data-obra-module="eap"');
    expect(html).toContain('data-obra-module="planejamento"');
    expect(html).toContain('data-obra-module="linha-de-balanco"');
    expect(html).toContain('data-obra-module="servicos"');
  });

  test("módulo de Execução (frentes) mostra os subitens da fase Execução", () => {
    const html = renderShell("frentes");
    expect(html).toContain('data-obra-module="frentes"');
    expect(html).toContain('data-obra-module="producao"');
    expect(html).toContain('data-obra-module="rdo"');
  });

  test("módulo de Suporte (ia) mostra os subitens da fase Suporte", () => {
    const html = renderShell("ia");
    expect(html).toContain('data-obra-module="ia"');
  });

  test("renderiza o conteúdo do módulo ativo (EAP)", () => {
    const html = renderShell("eap");
    expect(html).toContain("EAP — Estrutura Analítica do Projeto");
  });

  test("renderiza o conteúdo do módulo ativo (Linha de Balanço)", () => {
    const html = renderShell("linha-de-balanco");
    expect(html).toContain("Linha de Balanço");
  });
});
