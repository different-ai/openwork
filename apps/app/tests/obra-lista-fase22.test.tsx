/** @jsxImportSource react */
import { beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { ObraListaContent } from "../src/react-app/domains/engenharia/obra/pages/obra-lista";
import { resetObraRepository, useObraRepository } from "../src/react-app/domains/engenharia/obra/obra-repository";
import type { Obra } from "../src/react-app/domains/engenharia/obra/obra-types";

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

const noop = () => undefined;

describe("Central de Obras — FASE 22 (busca, filtro, soft-delete, obra ativa)", () => {
  test("renderiza busca, filtro de status e ações por card", () => {
    const obras = useObraRepository.getState().obras;
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ObraListaContent
          obras={obras}
          onAbrir={noop}
          onEditar={noop}
          onArquivar={noop}
          onRestaurar={noop}
          onExcluir={noop}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("Central de Obras");
    expect(html).toContain('data-obra-busca');
    expect(html).toContain('data-obra-status-filtro');
    expect(html).toContain('data-obra-editar');
    expect(html).toContain('data-obra-arquivar');
    expect(html).toContain('data-obra-excluir');
    expect(html).toContain("Abrir");
  });

  test("obra ativa recebe badge 'Ativa' e atributo data-obra-ativa", () => {
    const obras = useObraRepository.getState().obras;
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ObraListaContent
          obras={obras}
          activeObraId="OBRA-DEMO-001"
          onAbrir={noop}
          onEditar={noop}
          onArquivar={noop}
          onRestaurar={noop}
          onExcluir={noop}
        />
      </MemoryRouter>,
    );
    expect(html).toContain('data-obra-ativa');
    expect(html).toContain("Ativa");
  });

  test("obra arquivada mostra ação de restaurar em vez de arquivar", () => {
    const obras: Obra[] = [
      { id: "OBRA-ARQ", nome: "Obra Arquivada", status: "PROPOSTA", arquivada: true },
    ];
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ObraListaContent
          obras={obras}
          onAbrir={noop}
          onEditar={noop}
          onArquivar={noop}
          onRestaurar={noop}
          onExcluir={noop}
        />
      </MemoryRouter>,
    );
    expect(html).toContain('data-obra-restaurar="OBRA-ARQ"');
    expect(html).not.toContain('data-obra-arquivar="OBRA-ARQ"');
    expect(html).toContain("ARQUIVADA");
  });

  test("badge de status reflete statusEfetivo (ARQUIVADA derivado)", () => {
    const obras: Obra[] = [
      { id: "OBRA-EM", nome: "Obra Execução", status: "EM_EXECUCAO" },
    ];
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ObraListaContent
          obras={obras}
          onAbrir={noop}
          onEditar={noop}
          onArquivar={noop}
          onRestaurar={noop}
          onExcluir={noop}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("EM_EXECUCAO");
  });

  test("metadados opcionais (dataInicio/localização/responsável) aparecem no card", () => {
    const obras: Obra[] = [
      {
        id: "OBRA-META",
        nome: "Obra com Metadados",
        status: "PROPOSTA",
        dataInicio: "2026-01-05",
        localizacao: "Curitiba, PR",
        responsavel: "Eng. Bruno",
      },
    ];
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ObraListaContent
          obras={obras}
          onAbrir={noop}
          onEditar={noop}
          onArquivar={noop}
          onRestaurar={noop}
          onExcluir={noop}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("Início: 2026-01-05");
    expect(html).toContain("Local: Curitiba, PR");
    expect(html).toContain("Responsável: Eng. Bruno");
  });
});
