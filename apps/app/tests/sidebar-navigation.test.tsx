/** @jsxImportSource react */
import { beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { buildEngenhariaNavigation } from "../src/react-app/domains/engenharia/obra/obra-navigation";
import { useNavigationState } from "../src/react-app/domains/navigation/navigation-state";
import { SidebarNavigationList } from "../src/react-app/domains/navigation/sidebar-navigation";

const EAP_ROUTE = "/dominios/engenharia/obras/OBRA-MODELO-EAP-001/eap";

beforeEach(() => {
  useNavigationState.setState({ expandedNodeIds: [] });
});

describe("SidebarNavigationList — renderer genérico do Core (SSR)", () => {
  test("renderiza o nó raiz de domínio com markup data-driven sem erro", () => {
    const tree = buildEngenhariaNavigation();
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[EAP_ROUTE]}>
        <SidebarNavigationList nodes={tree} depth={0} />
      </MemoryRouter>,
    );

    expect(html).toContain("Engenharia");
    expect(html).toContain("data-nav-node=\"domain:engenharia\"");
    expect(html).toContain("data-nav-type=\"domain\"");
    expect(html).toContain("aria-expanded=\"false\"");
  });

  test("nó raiz recolhido não renderiza descendentes (expansão condicionada ao estado)", () => {
    const tree = buildEngenhariaNavigation();
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[EAP_ROUTE]}>
        <SidebarNavigationList nodes={tree} depth={0} />
      </MemoryRouter>,
    );
    expect(html).toContain("Engenharia");
    expect(html).not.toContain("OBRA-MODELO-EAP-001");
  });
});

