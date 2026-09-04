import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  atividadeParaLobLinha,
  derivarGradeLob,
  gerarSemanas,
} from "../src/react-app/domains/linha-de-balanco/lob-data";
import type { LobAtividade } from "../src/react-app/domains/linha-de-balanco/lob-types";

/**
 * Auditoria anti-hardcode da capacidade genérica de Linha de Balanço (FASE 21).
 * Garante que a pasta domains/linha-de-balanco (contrato + componentes) NÃO
 * dependa de conceitos de um domínio/obra específica.
 */
const LOB_DIR = join(
  import.meta.dir,
  "..",
  "src",
  "react-app",
  "domains",
  "linha-de-balanco",
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

describe("linha-de-balanco — auditoria anti-hardcode", () => {
  const files = readdirSync(LOB_DIR).filter((name) => /\.(ts|tsx)$/.test(name));

  test("arquivos da capacidade existem e são auditáveis", () => {
    expect(files).toContain("lob-types.ts");
    expect(files).toContain("lob-data.ts");
    expect(files).toContain("lob-grade.tsx");
    expect(files).toContain("lob-help.tsx");
  });

  test("nenhum termo específico de domínio/obra aparece na capacidade genérica", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(join(LOB_DIR, file), "utf8").toLowerCase();
      for (const term of FORBIDDEN_TERMS) {
        if (content.includes(term.toLowerCase())) {
          offenders.push(`${file} -> ${term}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("lob-data — helpers genéricos (FASE 21)", () => {
  test("gerarSemanas cobre a duração a partir da data de início", () => {
    const semanas = gerarSemanas("2026-01-05", 698);
    expect(semanas.length).toBe(100);
    expect(semanas[0].inicio).toBe("2026-01-05");
    expect(semanas[0].fim).toBe("2026-01-11");
    expect(semanas[99].inicio).toBe("2027-11-29");
    expect(semanas[99].fim).toBe("2027-12-05");
  });

  test("gerarSemanas retorna [] para duração negativa", () => {
    expect(gerarSemanas("2026-01-05", -1)).toEqual([]);
  });

  test("atividadeParaLobLinha converte atividade em semanas ativas", () => {
    const atividade: LobAtividade = {
      id: "A",
      nome: "Serviço A",
      inicio: 0,
      fim: 16,
      duracao: 16,
      critico: "CRÍTICO",
    };
    const linha = atividadeParaLobLinha(atividade);
    expect(linha.semanasAtivas).toEqual([0, 1, 2]);
    expect(linha.critico).toBe("CRÍTICO");
  });

  test("atividade sem duração não entra na grade", () => {
    const atividades: LobAtividade[] = [
      { id: "A", nome: "Sem duração", inicio: 0, fim: 0, duracao: 0, critico: "—" },
      { id: "B", nome: "Com duração", inicio: 0, fim: 7, duracao: 7, critico: "Sequencial" },
    ];
    const grade = derivarGradeLob(atividades, "2026-01-05");
    expect(grade.linhas.length).toBe(1);
    expect(grade.linhas[0].id).toBe("B");
  });
});
