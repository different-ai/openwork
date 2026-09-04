/** @jsxImportSource react */
import { beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { ObraDashboard, type DashboardWidget } from "../src/react-app/domains/engenharia/obra/obra-dashboard";
import { KpiBar, type KpiItem } from "../src/react-app/domains/engenharia/obra/obra-kpi-bar";
import { ObraVisaoGeral } from "../src/react-app/domains/engenharia/obra/pages/obra-visao-geral";
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

describe("KpiBar — drill-down (FASE 22)", () => {
  test("KPI com target e onNavigate é clicável e expõe a rota de origem", () => {
    const items: KpiItem[] = [
      { id: "kpi-a", label: "Torres", value: 3, target: "/obras/X/caracterizacao" },
      { id: "kpi-b", label: "Nós", value: 81 },
    ];
    const html = renderToStaticMarkup(
      <KpiBar items={items} onNavigate={() => undefined} />,
    );
    expect(html).toContain('data-kpi-target="/obras/X/caracterizacao"');
    expect(html).toContain('role="button"');
    // KPI sem target não é clicável (apenas um card com role=button).
    expect(html.match(/role="button"/g)?.length).toBe(1);
  });

  test("sem onNavigate, KPI com target não é clicável (primitivo SSR-testável)", () => {
    const items: KpiItem[] = [
      { id: "kpi-a", label: "Torres", value: 3, target: "/obras/X/caracterizacao" },
    ];
    const html = renderToStaticMarkup(<KpiBar items={items} />);
    expect(html).not.toContain('role="button"');
  });
});

describe("ObraDashboard — widgets e expansão (FASE 22)", () => {
  const widgets: DashboardWidget[] = [
    {
      id: "widget-a",
      title: "Identidade",
      content: <span data-widget-content="a">Conteúdo A</span>,
    },
    {
      id: "widget-b",
      title: "Caracterização",
      content: <span data-widget-content="b">Conteúdo B</span>,
    },
  ];

  test("renderiza widgets em grade com botão de expandir", () => {
    const html = renderToStaticMarkup(<ObraDashboard widgets={widgets} />);
    expect(html).toContain("data-obra-dashboard");
    expect(html).toContain('data-widget="widget-a"');
    expect(html).toContain('data-widget="widget-b"');
    expect(html).toContain('data-widget-expand="widget-a"');
    expect(html).toContain('data-widget-expand="widget-b"');
    expect(html).toContain("Conteúdo A");
    expect(html).toContain("Conteúdo B");
  });

  test("sem widget expandido, não renderiza overlay de tela cheia", () => {
    const html = renderToStaticMarkup(<ObraDashboard widgets={widgets} />);
    expect(html).not.toContain("data-obra-dashboard-expanded");
  });
});

describe("Visão Geral — dashboard com KPIs clicáveis (FASE 22)", () => {
  test("KPIs de caracterização e EAP apontam para o módulo de origem", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ObraVisaoGeral obra={OBRA_MODELO} />
      </MemoryRouter>,
    );
    expect(html).toContain("data-obra-dashboard");
    expect(html).toContain('data-kpi="kpi-torres"');
    expect(html).toContain('data-kpi="kpi-eap-nos"');
    // drill-down para o módulo de origem
    expect(html).toContain(`data-kpi-target="/dominios/engenharia/obras/${OBRA_MODELO_EAP_ID}/caracterizacao"`);
    expect(html).toContain(`data-kpi-target="/dominios/engenharia/obras/${OBRA_MODELO_EAP_ID}/eap"`);
    // widgets de identidade e caracterização
    expect(html).toContain('data-widget="widget-identidade"');
    expect(html).toContain('data-widget="widget-caracterizacao"');
  });

  test("início do cronograma é apresentado como derivado (não sobrescreve cadastro)", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ObraVisaoGeral obra={OBRA_MODELO} />
      </MemoryRouter>,
    );
    expect(html).toContain("Início do cronograma (derivado)");
  });
});
