// Registro de Domínios (Core → Domínio → Entidade).
// O Core conhece APENAS esta interface. Domínios específicos (Engenharia, Administração,
// Medicina, Direito...) registram-se via registerDomain (side-effect), sem tocar no Core.
import type { ReactNode } from "react";
import type { NavigationNode } from "./navigation/navigation-types";

export type DomainDefinition = {
  id: string;
  label: string;
  /** Rota inicial do domínio (primeira entidade). */
  homeRoute: string;
  /** Árvore de navegação declarativa (data-driven). O Core apenas interpreta os nós. */
  navigation: NavigationNode[];
  /** Renderiza a rota /dominios/:domainId<path> (ex.: "/obras/:obraId/eap"). */
  renderRoute: (path: string) => ReactNode;
};

const registry = new Map<string, DomainDefinition>();

export function registerDomain(domain: DomainDefinition): void {
  registry.set(domain.id, domain);
}

export function listDomains(): DomainDefinition[] {
  return [...registry.values()];
}

export function getDomain(id: string): DomainDefinition | null {
  return registry.get(id) ?? null;
}

