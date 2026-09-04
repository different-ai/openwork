import { beforeEach, describe, expect, test } from "bun:test";

import {
  OBRA_MODELO_ID,
  listObras,
  listObrasArquivadas,
  listObrasAtivas,
  resetObraRepository,
  statusEfetivo,
  useObraRepository,
} from "../src/react-app/domains/engenharia/obra/obra-repository";
import type { Obra } from "../src/react-app/domains/engenharia/obra/obra-types";

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
  resetObraRepository();
});

describe("ObraRepository — FASE 22 (CRUD, soft-delete, status)", () => {
  test("createObra aceita metadados opcionais (status, datas, localização, responsável)", () => {
    const obra = useObraRepository.getState().createObra({
      nome: "Obra Completa",
      status: "EM_EXECUCAO",
      dataInicio: "2026-01-05",
      dataFim: "2026-12-20",
      localizacao: "São Paulo, SP",
      responsavel: "Eng. Ana",
    });
    expect(obra.status).toBe("EM_EXECUCAO");
    expect(obra.dataInicio).toBe("2026-01-05");
    expect(obra.dataFim).toBe("2026-12-20");
    expect(obra.localizacao).toBe("São Paulo, SP");
    expect(obra.responsavel).toBe("Eng. Ana");
    expect(obra.arquivada).toBeUndefined();
  });

  test("createObra sem metadados usa defaults (status PROPOSTA, campos nulos)", () => {
    const obra = useObraRepository.getState().createObra({ nome: "Obra Mínima" });
    expect(obra.status).toBe("PROPOSTA");
    expect(obra.dataInicio).toBeNull();
    expect(obra.dataFim).toBeNull();
    expect(obra.localizacao).toBeNull();
    expect(obra.responsavel).toBeNull();
  });

  test("updateObra altera campos preservando id", () => {
    const obra = useObraRepository.getState().createObra({ nome: "Antes" });
    useObraRepository.getState().updateObra(obra.id, {
      nome: "Depois",
      status: "CONCLUIDA",
      localizacao: "Rio de Janeiro, RJ",
    });
    const atualizada = listObras().find((o) => o.id === obra.id);
    expect(atualizada?.nome).toBe("Depois");
    expect(atualizada?.status).toBe("CONCLUIDA");
    expect(atualizada?.localizacao).toBe("Rio de Janeiro, RJ");
    expect(atualizada?.id).toBe(obra.id);
  });

  test("statusEfetivo deriva ARQUIVADA de arquivada (soft-delete), nunca persistido", () => {
    const obra = useObraRepository.getState().createObra({ nome: "Obra Status" });
    expect(statusEfetivo(obra)).toBe("PROPOSTA");
    useObraRepository.getState().archiveObra(obra.id);
    const arquivada = listObras().find((o) => o.id === obra.id)!;
    expect(statusEfetivo(arquivada)).toBe("ARQUIVADA");
    // O campo `status` original não é alterado (ARQUIVADA é derivado).
    expect(arquivada.status).toBe("PROPOSTA");
  });

  test("archiveObra/unarchiveObra alternam soft-delete", () => {
    const obra = useObraRepository.getState().createObra({ nome: "Obra Arquivável" });
    useObraRepository.getState().archiveObra(obra.id);
    expect(listObras().find((o) => o.id === obra.id)?.arquivada).toBe(true);
    useObraRepository.getState().unarchiveObra(obra.id);
    expect(listObras().find((o) => o.id === obra.id)?.arquivada).toBe(false);
  });

  test("deleteObra remove definitivamente da fonte única", () => {
    const obra = useObraRepository.getState().createObra({ nome: "Obra Excluída" });
    expect(listObras().some((o) => o.id === obra.id)).toBe(true);
    useObraRepository.getState().deleteObra(obra.id);
    expect(listObras().some((o) => o.id === obra.id)).toBe(false);
  });

  test("listObrasAtivas exclui arquivadas; listObrasArquivadas retorna só arquivadas", () => {
    const ativa = useObraRepository.getState().createObra({ nome: "Ativa" });
    const arquivada = useObraRepository.getState().createObra({ nome: "Arquivada" });
    useObraRepository.getState().archiveObra(arquivada.id);
    expect(listObrasAtivas().map((o) => o.id)).toContain(ativa.id);
    expect(listObrasAtivas().map((o) => o.id)).not.toContain(arquivada.id);
    expect(listObrasArquivadas().map((o) => o.id)).toContain(arquivada.id);
    expect(listObrasArquivadas().map((o) => o.id)).not.toContain(ativa.id);
  });

  test("obra-modelo permanece ativa e com caracterização/EAP (compatibilidade)", () => {
    const modelo = listObras().find((o) => o.id === OBRA_MODELO_ID) as Obra;
    expect(statusEfetivo(modelo)).toBe("PROPOSTA");
    expect(modelo.caracterizacao?.torres).toBe(1);
    expect(modelo.eap?.total).toBe(81);
  });
});
