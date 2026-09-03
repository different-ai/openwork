// Camada de armazenamento local do repositório de Obras (FASE 04.2-B).
// A UI NUNCA acessa localStorage diretamente: ela fala com o repository
// (obra-repository.ts), que por sua vez usa este módulo. Trocar por backend
// depois = substituir apenas esta camada.
import type { Obra } from "./obra-types";

export const OBRA_STORAGE_KEY = "openwork.obra-repository.v1";
const STORAGE_VERSION = 1;

function isObra(value: unknown): value is Obra {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.nome === "string" &&
    typeof record.status === "string"
  );
}

/** Carrega e valida a lista persistida; null quando não há dado utilizável. */
export function loadObrasFromStorage(): Obra[] | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(OBRA_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as { version?: unknown; obras?: unknown };
    if (record.version !== STORAGE_VERSION) return null;
    if (!Array.isArray(record.obras)) return null;
    const obras = record.obras.filter(isObra);
    if (obras.length === 0 && record.obras.length > 0) return null;
    return obras;
  } catch {
    return null;
  }
}

/** Persiste a lista. Nunca lança para a UI. */
export function saveObrasToStorage(obras: Obra[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(
      OBRA_STORAGE_KEY,
      JSON.stringify({ version: STORAGE_VERSION, obras }),
    );
  } catch {
    // Armazenamento indisponível: mantém estado em memória (best-effort).
  }
}

/** Remove os dados persistidos (útil em testes/reset). */
export function clearObrasStorage(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(OBRA_STORAGE_KEY);
  } catch {
    // ignore
  }
}
