/** @jsxImportSource react */
import { beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { ObraListaContent, ObraListaPage } from "../src/react-app/domains/engenharia/obra/pages/obra-lista";
import { ObraNovaPage } from "../src/react-app/domains/engenharia/obra/pages/obra-nova";
import { ObraPlanejamento } from "../src/react-app/domains/engenharia/obra/pages/obra-planejamento";
import { OBRA_MODELO_ID, listObras, resetObraRepository, useObraRepository } from "../src/react-app/domains/engenharia/obra/obra-repository";
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
  useObraStore.setState({ selectedModules: {} });
});

describe("Gestão de Obras V1 — lista (SSR)", () => {
  test("renderiza múltiplas obras a partir do repositório", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/dominios/engenharia/obras"]}>
        <ObraListaPage />
      </MemoryRouter>,
    );
    expect(html).toContain("Obras");
    expect(html).toContain('data-obra-card="OBRA-MODELO-EAP-001"');
    expect(html).toContain('data-obra-card="OBRA-DEMO-001"');
    expect(html).toContain("Obra Demonstrativa 01");
    expect(html).toContain("Obra Demonstrativa 02");
    expect(html).toContain("Abrir");
    expect(html).toContain("Nova obra");
  });

  test("obra criada aparece na lista (mesma fonte do repositório)", () => {
    useObraRepository.getState().createObra({ nome: "Obra Criada Na Lista" });
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/dominios/engenharia/obras"]}>
        <ObraListaContent obras={listObras()} />
      </MemoryRouter>,
    );
    expect(html).toContain("Obra Criada Na Lista");
  });

  test("estado vazio é tratado", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/dominios/engenharia/obras"]}>
        <ObraListaContent obras={[]} />
      </MemoryRouter>,
    );
    expect(html).toContain("Nenhuma obra");
  });
});

describe("Gestão de Obras V1 — criação (SSR)", () => {
  test("formulário mínimo renderiza nome e valida (botão desabilitado sem nome)", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/dominios/engenharia/obras/nova"]}>
        <ObraNovaPage />
      </MemoryRouter>,
    );
    expect(html).toContain("Nova obra");
    expect(html).toContain('id="obra-nome"');
    expect(html).toContain("Criar obra");
    // botão desabilitado enquanto o nome estiver vazio (validação mínima)
    expect(html).toContain("disabled");
  });
});

describe("Gestão de Obras V1 — compatibilidade e isolamento", () => {
  test("obra-modelo continua disponível com caracterização e EAP (compat)", () => {
    const obra = listObras().find((o) => o.id === OBRA_MODELO_ID);
    expect(obra?.caracterizacao?.torres).toBe(1);
    expect(obra?.eap?.total).toBe(81);
  });

  test("planejamento recebe contexto dinâmico da obra (sem hardcode)", () => {
    const obra = {
      id: "OBRA-XYZ",
      nome: "Obra Especial 99",
      status: "PROPOSTA" as const,
    };
    const html = renderToStaticMarkup(<ObraPlanejamento obra={obra} />);
    expect(html).toContain("Obra Especial 99");
    expect(html).not.toContain("OBRA-MODELO-EAP-001");
  });

  test("estado de módulo selecionado é isolado por obra", () => {
    useObraStore.getState().selectModule("OBRA-A", "eap");
    useObraStore.getState().selectModule("OBRA-B", "ia");
    const state = useObraStore.getState();
    expect(state.selectedModules["OBRA-A"]).toBe("eap");
    expect(state.selectedModules["OBRA-B"]).toBe("ia");
    // Mudar a obra B não altera a obra A
    useObraStore.getState().selectModule("OBRA-B", null);
    expect(useObraStore.getState().selectedModules["OBRA-A"]).toBe("eap");
    expect(useObraStore.getState().selectedModules["OBRA-B"]).toBeNull();
  });
});
