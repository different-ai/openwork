/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { PlanningDashboard } from "../src/react-app/domains/planejamento/planning-dashboard";
import { PlanningItemDetails } from "../src/react-app/domains/planejamento/planning-details";
import { PLANNING_DEMO_DATA } from "../src/react-app/domains/planejamento/planning-demo-data";
import {
  PLANNING_HELP_SECTIONS,
  PlanningHelp,
} from "../src/react-app/domains/planejamento/planning-help";
import type { PlanningDashboardData } from "../src/react-app/domains/planejamento/planning-types";

describe("PlanningDashboard — SSR (capacidade genérica)", () => {
  test("renderiza título, contexto e KPIs derivados", () => {
    const html = renderToStaticMarkup(<PlanningDashboard data={PLANNING_DEMO_DATA} />);
    expect(html).toContain("Planejamento");
    expect(html).toContain("data-planning-dashboard");
    expect(html).toContain("data-kpi=\"kpi-total\"");
    expect(html).toContain("data-kpi=\"kpi-atencao\"");
    expect(html).toContain("data-kpi=\"kpi-concluidos\"");
    expect(html).toContain("Total");
    expect(html).toContain("Atenção");
    expect(html).toContain("Em andamento");
  });

  test("renderiza árvore e timeline com os itens da hierarquia", () => {
    const html = renderToStaticMarkup(<PlanningDashboard data={PLANNING_DEMO_DATA} />);
    expect(html).toContain("data-planning-tree");
    expect(html).toContain("data-planning-timeline");
    expect(html).toContain("Grupo A");
    expect(html).toContain("Atividade 01");
    expect(html).toContain("data-planning-row");
    expect(html).toContain("data-planning-bar");
  });

  test("deriva alertas a partir dos dados (estado preenchido)", () => {
    const html = renderToStaticMarkup(<PlanningDashboard data={PLANNING_DEMO_DATA} />);
    expect(html).toContain("data-alert");
    expect(html).toContain("Atrasado");
    expect(html).toContain("Sem período");
  });

  test("trata estado vazio sem quebrar", () => {
    const empty: PlanningDashboardData = {
      context: { title: "Planejamento" },
      items: [],
    };
    const html = renderToStaticMarkup(<PlanningDashboard data={empty} />);
    expect(html).toContain("Sem itens de planejamento");
  });

  test("painel de detalhes renderiza os campos do item", () => {
    const item = PLANNING_DEMO_DATA.items.find((i) => i.id === "atividade-01");
    expect(item).toBeDefined();
    const html = renderToStaticMarkup(
      <PlanningItemDetails item={item!} parentName="Pacote A.1" />,
    );
    expect(html).toContain("data-planning-details");
    expect(html).toContain("Atividade 01");
    expect(html).toContain("Em andamento");
    expect(html).toContain("80%");
    expect(html).toContain("15/06/2026");
    expect(html).toContain("Pacote A.1");
  });

  test("conteúdo da ajuda contextual cobre as perguntas da V1", () => {
    expect(PLANNING_HELP_SECTIONS.map((s) => s.question)).toEqual([
      "O que é?",
      "Para que serve?",
      "Como funciona?",
      "O que devo fazer?",
    ]);
    const html = renderToStaticMarkup(<PlanningHelp />);
    expect(html).toContain("Planejamento");
  });
});
