import { describe, expect, test } from "bun:test";

import { buildEngenhariaNavigation } from "../src/react-app/domains/engenharia/obra/obra-navigation";
import {
  DOMAIN_ENGENHARIA_ID,
  OBRA_MODULES,
  obraNovaRoute,
  obrasListRoute,
} from "../src/react-app/domains/engenharia/obra/obra-routes";
import {
  OBRA_MODELO_ID,
  SEED_OBRAS,
} from "../src/react-app/domains/engenharia/obra/obra-repository";
import {
  collectNodeIds,
  findActiveNavigationPath,
  hasActiveDescendant,
  isNodeActive,
  isNodeRouteActive,
  resolveNavigationUpLevel,
} from "../src/react-app/domains/navigation/navigation-utils";

function obrasEntities(tree: ReturnType<typeof buildEngenhariaNavigation>) {
  const group = tree[0].children?.[0];
  return (group?.children ?? []).filter(
    (n) => n.type === "entity" && n.label !== "+ Nova obra",
  );
}

describe("navegação do domínio Engenharia (data-driven a partir do repositório)", () => {
  const tree = buildEngenhariaNavigation(SEED_OBRAS);

  test("raiz é um único nó de domínio apontando para a lista de obras", () => {
    expect(tree).toHaveLength(1);
    const domain = tree[0];
    expect(domain.type).toBe("domain");
    expect(domain.id).toBe(`domain:${DOMAIN_ENGENHARIA_ID}`);
    expect(domain.label).toBe("Engenharia");
    expect(domain.route).toBe(obrasListRoute());
  });

  test("estrutura domain → group(Obras) → (+ Nova obra + obras entity)", () => {
    const domain = tree[0];
    const obras = domain.children?.[0];
    expect(obras?.type).toBe("group");
    expect(obras?.label).toBe("Obras");
    expect(obras?.children?.[0]?.label).toBe("+ Nova obra");
    expect(obras?.children?.[0]?.route).toBe(obraNovaRoute());

    const entities = obrasEntities(tree);
    expect(entities.length).toBe(SEED_OBRAS.length);
    const modelo = entities[0];
    expect(modelo?.label).toBe("OBRA-MODELO-EAP-001");
    // A obra agora agrupa os módulos por FASES (grupos) na sidebar.
    const fases = modelo?.children ?? [];
    expect(fases.length).toBeGreaterThanOrEqual(3);
    const faseLabels = fases.map((n) => n.label);
    expect(faseLabels).toContain("Preparação");
    expect(faseLabels).toContain("Execução");
    expect(faseLabels).toContain("Suporte");
    // Os módulos vivem dentro das fases.
    const allModuleLabels = fases.flatMap((f) => f.children?.map((c) => c.label) ?? []);
    expect(allModuleLabels).toContain("Visão Geral");
    expect(allModuleLabels).toContain("EAP");
    expect(allModuleLabels).toContain("Disciplinas");
    expect(allModuleLabels).toContain("Serviços");
    expect(allModuleLabels).toContain("Linha de Balanço");
  });

  test("múltiplas obras aparecem com rotas próprias (derivadas dos dados)", () => {
    const entities = obrasEntities(tree);
    const names = entities.map((n) => n.label);
    expect(names).toContain("OBRA-MODELO-EAP-001");
    expect(names).toContain("Obra Demonstrativa 01");
    expect(names).toContain("Obra Demonstrativa 02");
    for (const entity of entities) {
      expect(entity.route).toContain("/obras/");
    }
  });

  test("obra nova na lista aparece na navegação", () => {
    const extra: (typeof SEED_OBRAS)[number] = {
      id: "OBRA-NOVA-TESTE",
      nome: "Obra de Teste",
      status: "PROPOSTA",
    };
    const comNova = buildEngenhariaNavigation([...SEED_OBRAS, extra]);
    const entities = obrasEntities(comNova);
    expect(entities.some((n) => n.id.includes("OBRA-NOVA-TESTE"))).toBe(true);
    expect(entities.some((n) => n.label === "Obra de Teste")).toBe(true);
  });

  test("todos os módulos da obra-modelo possuem rota própria e tipo module", () => {
    const entities = obrasEntities(tree);
    const fases = entities[0]?.children ?? [];
    const modules = fases.flatMap((fase) => fase.children ?? []);
    expect(modules.length).toBeGreaterThanOrEqual(11);
    for (const module of modules) {
      expect(module.type).toBe("module");
      expect(module.route).toMatch(
        /^\/dominios\/engenharia\/obras\/OBRA-MODELO-EAP-001\//,
      );
    }
  });

  test("collectNodeIds percorre todos os nós", () => {
    const ids = collectNodeIds(tree);
    expect(ids.length).toBeGreaterThanOrEqual(1 + 1 + 1 + SEED_OBRAS.length);
    expect(ids).toContain(`domain:${DOMAIN_ENGENHARIA_ID}`);
  });

  test("OBRA_MODULES ainda expõe os módulos da casca", () => {
    expect(OBRA_MODULES.length).toBe(11);
    expect(OBRA_MODELO_ID).toBe("OBRA-MODELO-EAP-001");
  });
});

describe("navigation-utils (Core genérico)", () => {
  const moduleNode = {
    id: "m",
    label: "EAP",
    type: "module" as const,
    route: "/dominios/x/obras/O1/eap",
  };
  const entityNode = {
    id: "e",
    label: "Obra",
    type: "entity" as const,
    route: "/dominios/x/obras/O1",
    children: [moduleNode],
  };

  test("isNodeRouteActive: module casa exato; pai casa prefixo", () => {
    expect(isNodeRouteActive(moduleNode, "/dominios/x/obras/O1/eap")).toBe(true);
    expect(isNodeRouteActive(moduleNode, "/dominios/x/obras/O1")).toBe(false);
    expect(isNodeRouteActive(entityNode, "/dominios/x/obras/O1/eap")).toBe(true);
  });

  test("hasActiveDescendant / isNodeActive", () => {
    expect(hasActiveDescendant(entityNode, "/dominios/x/obras/O1/eap")).toBe(true);
    expect(isNodeActive(entityNode, "/dominios/x/obras/O1/eap")).toBe(true);
    expect(isNodeActive(entityNode, "/outro")).toBe(false);
  });
});

describe("resolveNavigationUpLevel — nível anterior derivado da rota (multi-obra)", () => {
  const tree = buildEngenhariaNavigation(SEED_OBRAS);
  const primeiraObra = obrasEntities(tree)[0];
  const obraRoute = primeiraObra?.route ?? "";
  const eapRoute = `${obraRoute}/eap`;
  const listaRoute = obrasListRoute();

  test("módulo interno retorna caminho completo até o módulo", () => {
    const path = findActiveNavigationPath(tree, eapRoute);
    expect(path.map((n) => n.type)).toEqual([
      "domain",
      "group",
      "entity",
      "group",
      "module",
    ]);
    expect(path[path.length - 1].route).toBe(eapRoute);
  });

  test("módulo → internal (volta para a entidade/pai)", () => {
    expect(resolveNavigationUpLevel(tree, eapRoute)).toEqual({
      kind: "internal",
      label: "OBRA-MODELO-EAP-001",
      route: obraRoute,
    });
  });

  test("rota da obra (visão geral) → internal (volta para a lista de obras)", () => {
    expect(resolveNavigationUpLevel(tree, obraRoute)).toEqual({
      kind: "internal",
      label: "Engenharia",
      route: listaRoute,
    });
  });

  test("rota da lista (topo do domínio) → external", () => {
    expect(resolveNavigationUpLevel(tree, listaRoute)).toEqual({ kind: "external" });
  });

  test("rota sem correspondência na árvore → none", () => {
    expect(resolveNavigationUpLevel(tree, "/dominios/engenharia/desconhecido")).toEqual({
      kind: "none",
    });
  });

  test("domínio de nível único (raiz sem filhos) → external", () => {
    const flat = [
      { id: "d", label: "D", type: "domain" as const, route: "/dominios/d/home" },
    ];
    expect(resolveNavigationUpLevel(flat, "/dominios/d/home")).toEqual({ kind: "external" });
  });
});
