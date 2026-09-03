// Domínio Engenharia — camada de armazenamento local da EAP (FASE 06.2-B).
// A UI NUNCA acessa localStorage diretamente: ela fala com o repository
// (obra-eap-repository.ts), que por sua vez usa este módulo. Trocar por backend
// depois = substituir apenas esta camada.
import type { ObraEap } from "./obra-eap-types";

export const OBRA_EAP_STORAGE_KEY = "openwork.obra-eap.v1";
const STORAGE_VERSION = 1;

function isObraEap(value: unknown): value is ObraEap {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.obraId === "string" &&
    typeof record.metadata === "object" &&
    record.metadata !== null &&
    Array.isArray(record.nodes)
  );
}

/** Carrega e valida o mapa de EAPs persistido; null quando não há dado utilizável. */
export function loadEapFromStorage(): Record<string, ObraEap> | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(OBRA_EAP_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as { version?: unknown; eaps?: unknown };
    if (record.version !== STORAGE_VERSION) return null;
    if (!record.eaps || typeof record.eaps !== "object") return null;
    const eaps = record.eaps as Record<string, unknown>;
    const result: Record<string, ObraEap> = {};
    for (const [obraId, eap] of Object.entries(eaps)) {
      if (isObraEap(eap) && eap.obraId === obraId) result[obraId] = eap;
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}

/** Persiste o mapa de EAPs. Nunca lança para a UI. */
export function saveEapToStorage(eaps: Record<string, ObraEap>): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(
      OBRA_EAP_STORAGE_KEY,
      JSON.stringify({ version: STORAGE_VERSION, eaps }),
    );
  } catch {
    // Armazenamento indisponível: mantém estado em memória (best-effort).
  }
}

/** Remove os dados persistidos (útil em testes/reset). */
export function clearEapStorage(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(OBRA_EAP_STORAGE_KEY);
  } catch {
    // ignore
  }
}
