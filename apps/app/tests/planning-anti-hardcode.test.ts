import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Auditoria anti-hardcode da capacidade genérica de Planejamento (V1).
 * Garante que a pasta domains/planejamento (contrato + componentes + dados
 * demonstrativos) NÃO dependa de conceitos de um domínio/obra específica.
 */

const PLANNING_DIR = join(
  import.meta.dir,
  "..",
  "src",
  "react-app",
  "domains",
  "planejamento",
);

const FORBIDDEN_TERMS = [
  "OBRA-MODELO-EAP-001",
  "torre",
  "apartamento",
  "pavimento",
  "engenharia",
  "obra-001",
];

describe("planejamento — auditoria anti-hardcode", () => {
  const files = readdirSync(PLANNING_DIR).filter((name) =>
    /\.(ts|tsx)$/.test(name),
  );

  test("arquivos da capacidade existem e são auditáveis", () => {
    expect(files).toContain("planning-types.ts");
    expect(files).toContain("planning-data.ts");
    expect(files).toContain("planning-dashboard.tsx");
  });

  test("nenhum termo específico de domínio/obra aparece na capacidade genérica", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(join(PLANNING_DIR, file), "utf8").toLowerCase();
      for (const term of FORBIDDEN_TERMS) {
        if (content.includes(term.toLowerCase())) {
          offenders.push(`${file} -> ${term}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("nomes do dataset demonstrativo são neutros", () => {
    const demo = readFileSync(join(PLANNING_DIR, "planning-demo-data.ts"), "utf8");
    expect(demo).toContain("Grupo A");
    expect(demo).toContain("Atividade 01");
    expect(demo).toContain("Pacote B.2");
  });
});
