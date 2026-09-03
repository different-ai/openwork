import { beforeEach, describe, expect, test } from "bun:test";

import {
  OBRA_MODELO_ID,
  SEED_OBRAS,
  createObraId,
  findObraById,
  initializeObraRepository,
  listObras,
  resetObraRepository,
  useObraRepository,
} from "../src/react-app/domains/engenharia/obra/obra-repository";
import { loadObrasFromStorage } from "../src/react-app/domains/engenharia/obra/obra-storage";

beforeEach(() => {
  // Em ambiente Bun (node-like) não existe localStorage global: injetamos um
  // storage em memória para validar a camada de persistência do repositório.
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

describe("ObraRepository — fonte única de obras (FASE 04.2-B)", () => {
  test("inicia com pelo menos duas obras demonstrativas + obra-modelo preservada", () => {
    const obras = listObras();
    expect(obras.length).toBeGreaterThanOrEqual(3);
    expect(obras.map((o) => o.id)).toContain(OBRA_MODELO_ID);
    expect(findObraById(OBRA_MODELO_ID)?.nome).toBe(OBRA_MODELO_ID);
    expect(obras.some((o) => o.id === "OBRA-DEMO-001")).toBe(true);
    expect(obras.some((o) => o.id === "OBRA-DEMO-002")).toBe(true);
  });

  test("listObras reflete o estado atual", () => {
    const antes = listObras().length;
    useObraRepository.getState().createObra({ nome: "Obra Lista" });
    expect(listObras().length).toBe(antes + 1);
  });

  test("findObraById resolve e rejeita ids desconhecidos", () => {
    expect(findObraById(OBRA_MODELO_ID)?.id).toBe(OBRA_MODELO_ID);
    expect(findObraById("OBRA-NAO-EXISTE")).toBeUndefined();
  });

  test("createObra gera id estável e único (não depende do nome)", () => {
    const a = useObraRepository.getState().createObra({ nome: "Alfa" });
    const b = useObraRepository.getState().createObra({ nome: "Beta" });
    expect(a.id).toMatch(/^OBRA-/);
    expect(a.id).not.toBe(b.id);
    expect(a.id).not.toContain("Alfa");
    expect(b.id).not.toContain("Beta");
    const nova = findObraById(a.id);
    expect(nova?.nome).toBe("Alfa");
    expect(nova?.status).toBe("PROPOSTA");
    expect(nova?.caracterizacao).toBeUndefined();
  });

  test("createObraId gera ids distintos para um conjunto", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 20; i += 1) ids.add(createObraId(ids));
    expect(ids.size).toBe(20);
  });

  test("persistência local: obra criada sobrevive a um reload (re-hidratação)", () => {
    const nova = useObraRepository.getState().createObra({
      nome: "Obra Sobrevive Ao Reload",
    });
    // 1) o armazenamento local contém a obra criada
    const persisted = loadObrasFromStorage();
    expect(persisted?.some((o) => o.id === nova.id)).toBe(true);

    // 2) simula reload: zera a memória (preservando o storage) e re-hidrata
    useObraRepository.setState({ obras: [] });
    initializeObraRepository();

    const aposReload = findObraById(nova.id);
    expect(aposReload?.nome).toBe("Obra Sobrevive Ao Reload");
    expect(listObras().length).toBeGreaterThanOrEqual(4);
  });

  test("resetObraRepository restaura os seeds", () => {
    useObraRepository.getState().createObra({ nome: "Temporária" });
    resetObraRepository();
    expect(listObras().map((o) => o.id)).toEqual(SEED_OBRAS.map((o) => o.id));
  });
});
