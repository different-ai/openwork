/** @jsxImportSource react */
import { beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { ObraEditarPage } from "../src/react-app/domains/engenharia/obra/pages/obra-editar";
import { OBRA_MODELO_ID, resetObraRepository, useObraRepository } from "../src/react-app/domains/engenharia/obra/obra-repository";

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
});

describe("Edição de obra (FASE 22)", () => {
  test("renderiza formulário de edição com campos de identificação e metadados", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[`/dominios/engenharia/obras/${OBRA_MODELO_ID}/editar`]}>
        <ObraEditarPage obraId={OBRA_MODELO_ID} />
      </MemoryRouter>,
    );
    expect(html).toContain("Editar obra");
    expect(html).toContain('id="obra-nome"');
    expect(html).toContain('id="obra-status"');
    expect(html).toContain('id="obra-data-inicio"');
    expect(html).toContain('id="obra-data-fim"');
    expect(html).toContain('id="obra-localizacao"');
    expect(html).toContain('id="obra-responsavel"');
    expect(html).toContain("Salvar");
  });

  test("obra inexistente mostra estado de não encontrada", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/dominios/engenharia/obras/NAO-EXISTE/editar"]}>
        <ObraEditarPage obraId="NAO-EXISTE" />
      </MemoryRouter>,
    );
    expect(html).toContain("Obra não encontrada");
  });

  test("updateObra persiste alterações na fonte única", () => {
    const obra = useObraRepository.getState().createObra({
      nome: "Obra Editável",
      status: "PROPOSTA",
    });
    useObraRepository.getState().updateObra(obra.id, {
      nome: "Obra Renomeada",
      status: "PLANEJAMENTO",
      localizacao: "Belo Horizonte, MG",
    });
    const atualizada = useObraRepository.getState().obras.find((o) => o.id === obra.id);
    expect(atualizada?.nome).toBe("Obra Renomeada");
    expect(atualizada?.status).toBe("PLANEJAMENTO");
    expect(atualizada?.localizacao).toBe("Belo Horizonte, MG");
  });
});
