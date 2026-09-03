/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { buildEngenhariaNavigation } from "../src/react-app/domains/engenharia/obra/obra-navigation";
import { SEED_OBRAS } from "../src/react-app/domains/engenharia/obra/obra-repository";
import { obrasListRoute } from "../src/react-app/domains/engenharia/obra/obra-routes";
import { DomainBackButton } from "../src/react-app/domains/domain-back-button";

const tree = buildEngenhariaNavigation(SEED_OBRAS);
function primeiraObraRoute(): string {
  const group = tree[0].children?.[0];
  const entity = (group?.children ?? []).find(
    (n) => n.type === "entity" && n.label !== "+ Nova obra",
  );
  return entity?.route ?? "";
}
const HOME_ROUTE = obrasListRoute();
const EAP_ROUTE = `${primeiraObraRoute()}/eap`;

describe("DomainBackButton — ação de voltar genérica do Core (SSR)", () => {
  test("módulo interno renderiza botão voltar para o nível anterior (internal)", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[EAP_ROUTE]}>
        <DomainBackButton navigation={tree} />
      </MemoryRouter>,
    );
    expect(html).toContain("data-domain-back-button");
    expect(html).toContain('data-domain-back-target="internal"');
    expect(html).toContain("aria-label=\"Voltar para OBRA-MODELO-EAP-001\"");
    expect(html).toContain("Voltar");
  });

  test("topo do domínio (lista de obras) renderiza voltar externo", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[HOME_ROUTE]}>
        <DomainBackButton navigation={tree} />
      </MemoryRouter>,
    );
    expect(html).toContain("data-domain-back-button");
    expect(html).toContain('data-domain-back-target="external"');
    expect(html).toContain("aria-label=\"Voltar para a visão principal\"");
  });

  test("rota sem correspondência não renderiza o botão", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/dominios/engenharia/desconhecido"]}>
        <DomainBackButton navigation={tree} />
      </MemoryRouter>,
    );
    expect(html).toBe("");
  });
});

