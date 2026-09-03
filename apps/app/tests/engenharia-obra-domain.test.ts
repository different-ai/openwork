import { describe, expect, test } from "bun:test";

import {
  OBRA_MODELO,
  OBRA_MODELO_ID,
  findObraModelo,
} from "../src/react-app/domains/engenharia/obra/obra-repository";
import {
  DOMAIN_ENGENHARIA_ID,
  OBRA_MODULES,
  OBRA_MODULE_LABEL,
  engenhariaDomainHome,
  isObraModule,
  obraRoute,
  obrasListRoute,
} from "../src/react-app/domains/engenharia/obra/obra-routes";

describe("domínio Engenharia — entidade Obra", () => {
  test("obra-modelo existe com identidade e status PROPOSTA", () => {
    expect(OBRA_MODELO.id).toBe("OBRA-MODELO-EAP-001");
    expect(OBRA_MODELO.nome).toBe("OBRA-MODELO-EAP-001");
    expect(OBRA_MODELO.status).toBe("PROPOSTA");
  });

  test("caracterização contém somente dados reais do projeto", () => {
    expect(OBRA_MODELO.caracterizacao).toEqual({
      torres: 1,
      lajes: 14,
      apartamentosPorPavimento: 1,
      subsolos: 0,
      sistemaConstrutivo: "concreto armado",
    });
  });

  test("resumo estrutural da EAP preserva 81 nós (10/24/47) e status PROPOSTA", () => {
    expect(OBRA_MODELO.eap.status).toBe("PROPOSTA");
    expect(OBRA_MODELO.eap.total).toBe(81);
    expect(OBRA_MODELO.eap.raizes).toBe(10);
    expect(OBRA_MODELO.eap.pacotes).toBe(24);
    expect(OBRA_MODELO.eap.trabalhos).toBe(47);
  });

  test("findObraModelo resolve a obra-modelo e rejeita ids desconhecidos", () => {
    expect(findObraModelo(OBRA_MODELO_ID)?.id).toBe(OBRA_MODELO_ID);
    expect(findObraModelo("OBRA-NAO-EXISTE")).toBeUndefined();
  });
});

describe("domínio Engenharia — rotas da Obra", () => {
  test("obraRoute gera as rotas nativas do domínio", () => {
    expect(obraRoute(OBRA_MODELO_ID)).toBe(
      `/dominios/${DOMAIN_ENGENHARIA_ID}/obras/OBRA-MODELO-EAP-001`,
    );
    expect(obraRoute(OBRA_MODELO_ID, "eap")).toBe(
      `/dominios/${DOMAIN_ENGENHARIA_ID}/obras/OBRA-MODELO-EAP-001/eap`,
    );
    expect(obraRoute(OBRA_MODELO_ID, "frentes")).toBe(
      `/dominios/${DOMAIN_ENGENHARIA_ID}/obras/OBRA-MODELO-EAP-001/frentes`,
    );
  });

  test("home do domínio aponta para a lista de obras", () => {
    expect(engenhariaDomainHome()).toBe(obrasListRoute());
    expect(obrasListRoute()).toBe(`/dominios/${DOMAIN_ENGENHARIA_ID}/obras`);
  });

  test("OBRA_MODULES expõe os módulos da casca (por fases)", () => {
    expect(OBRA_MODULES).toEqual([
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
    ]);
    for (const module of OBRA_MODULES) {
      expect(typeof OBRA_MODULE_LABEL[module]).toBe("string");
    }
  });

  test("isObraModule valida módulos conhecidos e rejeita os demais", () => {
    expect(isObraModule("eap")).toBe(true);
    expect(isObraModule("rdo")).toBe(true);
    expect(isObraModule("orcamento")).toBe(false);
    expect(isObraModule(null)).toBe(false);
    expect(isObraModule(undefined)).toBe(false);
  });
});
