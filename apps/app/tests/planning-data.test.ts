import { describe, expect, test } from "bun:test";

import {
  daysBetween,
  derivePlanningAlerts,
  derivePlanningPeriods,
  derivePlanningRows,
  derivePlanningSummary,
  parseIsoDate,
  planningRootIds,
  planningRowsForQuery,
} from "../src/react-app/domains/planejamento/planning-data";
import { PLANNING_DEMO_DATA } from "../src/react-app/domains/planejamento/planning-demo-data";

describe("planning-data — derivações puras (V1)", () => {
  test("parseIsoDate valida datas reais e rejeita inválidas", () => {
    expect(parseIsoDate("2026-08-15")?.getFullYear()).toBe(2026);
    expect(parseIsoDate("2026-13-01")).toBeNull();
    expect(parseIsoDate("2026-02-30")).toBeNull();
    expect(parseIsoDate(null)).toBeNull();
    expect(parseIsoDate("")).toBeNull();
  });

  test("resumo derivado do dataset demonstrativo", () => {
    const summary = derivePlanningSummary(PLANNING_DEMO_DATA);
    expect(summary.total).toBe(13);
    expect(summary.emAndamento).toBe(3);
    expect(summary.concluidos).toBe(3);
    // atencao = atrasado + em_andamento com fim < data de referência
    expect(summary.atencao).toBe(2);
  });

  test("alertas derivados cobrem atraso, sem período e concluído", () => {
    const alerts = derivePlanningAlerts(PLANNING_DEMO_DATA);
    const titles = alerts.map((alert) => alert.title);
    expect(titles).toContain("Atrasado");
    expect(titles).toContain("Sem período");
    expect(titles).toContain("Concluído");
    const atrasado = alerts.find((alert) => alert.title === "Atrasado");
    expect(atrasado?.detail).toContain("Atividade 03");
    const semPeriodo = alerts.filter((alert) => alert.title === "Sem período");
    expect(semPeriodo.length).toBe(2);
  });

  test("linhas preservam hierarquia pai antes do filho (pré-order)", () => {
    const rows = derivePlanningRows(PLANNING_DEMO_DATA.items, new Set());
    const order = rows.map((row) => row.item.id);
    expect(order.indexOf("grupo-a")).toBeLessThan(order.indexOf("pacote-a-1"));
    expect(order.indexOf("pacote-a-1")).toBeLessThan(order.indexOf("atividade-01"));
    expect(rows.find((row) => row.item.id === "grupo-a")?.depth).toBe(0);
    expect(rows.find((row) => row.item.id === "atividade-01")?.depth).toBe(2);
  });

  test("recolher um grupo oculta descendentes e expandir restaura", () => {
    const collapsed = derivePlanningRows(PLANNING_DEMO_DATA.items, new Set(["grupo-a"]));
    const ids = collapsed.map((row) => row.item.id);
    expect(ids).toContain("grupo-a");
    expect(ids).not.toContain("pacote-a-1");
    const expanded = derivePlanningRows(PLANNING_DEMO_DATA.items, new Set());
    expect(expanded.map((row) => row.item.id)).toContain("pacote-a-1");
  });

  test("planningRootIds devolve nós sem pai válido", () => {
    const roots = planningRootIds(PLANNING_DEMO_DATA.items);
    expect(roots).toEqual(["grupo-a", "grupo-b"]);
  });

  test("busca por nome preserva ancestrais e não revela itens sem match", () => {
    const rows = planningRowsForQuery(PLANNING_DEMO_DATA.items, "atividade 01");
    const names = rows.map((row) => row.item.name);
    expect(names).toContain("Grupo A");
    expect(names).toContain("Pacote A.1");
    expect(names).toContain("Atividade 01");
    expect(names).not.toContain("Atividade 02");
  });

  test("períodos mensais cobrem o intervalo das datas", () => {
    const periods = derivePlanningPeriods(PLANNING_DEMO_DATA.items);
    expect(periods.length).toBeGreaterThanOrEqual(3);
    expect(periods[0].label).toBe("Jun");
    expect(periods[0].start).toMatch(/^2026-06-01$/);
    expect(periods[periods.length - 1].label).toBe("Set");
  });

  test("daysBetween conta dias corridos entre datas", () => {
    expect(daysBetween("2026-06-01", "2026-06-01")).toBe(0);
    expect(daysBetween("2026-06-01", "2026-06-30")).toBe(29);
  });
});
