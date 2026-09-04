import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { deriveServicosSummary } from "../src/react-app/domains/servicos/servicos-data";
import type { ServicosData } from "../src/react-app/domains/servicos/servicos-types";

/**
 * Auditoria anti-hardcode da capacidade genérica de Serviços (FASE 21).
 * Garante que a pasta domains/servicos (contrato + componentes) NÃO dependa de
 * conceitos de um domínio/obra específica.
 */
const SERVICOS_DIR = join(
  import.meta.dir,
  "..",
  "src",
  "react-app",
  "domains",
  "servicos",
);

const FORBIDDEN_TERMS = [
  "OBRA-MODELO-EAP-001",
  "torre",
  "apartamento",
  "pavimento",
  "engenharia",
  "obra-001",
  "Escavação",
];

describe("servicos — auditoria anti-hardcode", () => {
  const files = readdirSync(SERVICOS_DIR).filter((name) => /\.(ts|tsx)$/.test(name));

  test("arquivos da capacidade existem e são auditáveis", () => {
    expect(files).toContain("servicos-types.ts");
    expect(files).toContain("servicos-data.ts");
    expect(files).toContain("servicos-table.tsx");
    expect(files).toContain("servicos-help.tsx");
  });

  test("nenhum termo específico de domínio/obra aparece na capacidade genérica", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(join(SERVICOS_DIR, file), "utf8").toLowerCase();
      for (const term of FORBIDDEN_TERMS) {
        if (content.includes(term.toLowerCase())) {
          offenders.push(`${file} -> ${term}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("servicos-data — helpers genéricos (FASE 21)", () => {
  test("deriveServicosSummary conta totais, críticos, sequenciais e com duração", () => {
    const data: ServicosData = {
      title: "Serviços",
      items: [
        { id: "1", codigo: "1", nome: "A", duracao: 10, inicio: "2026-01-05", fim: "2026-01-16", status: "CRÍTICO" },
        { id: "2", codigo: "2", nome: "B", duracao: 5, inicio: "2026-01-19", fim: "2026-01-23", status: "Sequencial" },
        { id: "3", codigo: "3", nome: "C", duracao: 0, inicio: null, fim: null, status: "—" },
      ],
    };
    const summary = deriveServicosSummary(data);
    expect(summary.total).toBe(3);
    expect(summary.criticos).toBe(1);
    expect(summary.sequenciais).toBe(1);
    expect(summary.comDuracao).toBe(2);
  });

  test("deriveServicosSummary trata lista vazia", () => {
    const data: ServicosData = { title: "Serviços", items: [] };
    const summary = deriveServicosSummary(data);
    expect(summary).toEqual({ total: 0, criticos: 0, sequenciais: 0, comDuracao: 0 });
  });
});
