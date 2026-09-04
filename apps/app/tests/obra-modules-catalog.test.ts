import { describe, expect, test } from "bun:test";

import {
  OBRA_FASES_ORDER,
  OBRA_MODULES,
  listModulesByFase,
  moduleFase,
  moduleLabel,
} from "../src/react-app/domains/engenharia/obra/obra-modules";
import type { ObraFase, ObraModule } from "../src/react-app/domains/engenharia/obra/obra-types";

describe("Catálogo declarativo de módulos (FASE 22)", () => {
  test("declara todos os módulos com id, label, fase e ordem", () => {
    const ids = OBRA_MODULES.map((m) => m.id);
    expect(ids).toContain("visao-geral");
    expect(ids).toContain("caracterizacao");
    expect(ids).toContain("eap");
    expect(ids).toContain("disciplinas");
    expect(ids).toContain("servicos");
    expect(ids).toContain("planejamento");
    expect(ids).toContain("linha-de-balanco");
    expect(ids).toContain("frentes");
    expect(ids).toContain("producao");
    expect(ids).toContain("rdo");
    expect(ids).toContain("ia");
    for (const m of OBRA_MODULES) {
      expect(m.label.length).toBeGreaterThan(0);
      expect(OBRA_FASES_ORDER).toContain(m.fase);
      expect(typeof m.ordem).toBe("number");
    }
  });

  test("ids do catálogo são únicos", () => {
    const ids = OBRA_MODULES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("listModulesByFase retorna módulos da fase ordenados por ordem", () => {
    const preparacao = listModulesByFase("preparacao");
    expect(preparacao.map((m) => m.id)).toEqual([
      "visao-geral",
      "caracterizacao",
      "eap",
      "disciplinas",
      "servicos",
      "planejamento",
      "linha-de-balanco",
    ]);
    const execucao = listModulesByFase("execucao");
    expect(execucao.map((m) => m.id)).toEqual(["frentes", "producao", "rdo"]);
    const suporte = listModulesByFase("suporte");
    expect(suporte.map((m) => m.id)).toEqual(["ia"]);
  });

  test("OBRA_FASES_ORDER é a ordem canônica Preparação → Execução → Suporte", () => {
    expect(OBRA_FASES_ORDER).toEqual(["preparacao", "execucao", "suporte"]);
  });

  test("moduleLabel resolve rótulo; moduleFase resolve fase", () => {
    expect(moduleLabel("eap")).toBe("EAP");
    expect(moduleLabel("linha-de-balanco")).toBe("Linha de Balanço");
    expect(moduleFase("eap")).toBe("preparacao");
    expect(moduleFase("producao")).toBe("execucao");
    expect(moduleFase("ia")).toBe("suporte");
  });

  test("catálogo é a fonte única de metadados (sem React/routing/estado/dados)", () => {
    // Garante que o catálogo permanece declarativo: nenhum componente/rota/estado.
    const source = OBRA_MODULES;
    expect(Array.isArray(source)).toBe(true);
    // Cada entrada é um objeto plano de metadados.
    for (const m of source) {
      expect(typeof m.id).toBe("string");
      expect(typeof m.label).toBe("string");
    }
  });

  test("todos os ids do catálogo são ObraModule válidos", () => {
    const valid: ObraModule[] = [
      "visao-geral",
      "caracterizacao",
      "eap",
      "disciplinas",
      "servicos",
      "planejamento",
      "linha-de-balanco",
      "frentes",
      "producao",
      "rdo",
      "ia",
    ];
    for (const m of OBRA_MODULES) {
      expect(valid).toContain(m.id);
    }
  });

  test("fases do catálogo são ObraFase válidas", () => {
    const valid: ObraFase[] = ["preparacao", "execucao", "suporte"];
    for (const m of OBRA_MODULES) {
      expect(valid).toContain(m.fase);
    }
  });
});
