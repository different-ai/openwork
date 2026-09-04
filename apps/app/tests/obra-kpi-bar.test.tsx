/** @jsxImportSource react */
import { beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { ObraEap } from "../src/react-app/domains/engenharia/obra/pages/obra-eap";
import { ObraLobGrade } from "../src/react-app/domains/engenharia/obra/pages/obra-lob-grade";
import { ObraPlanejamento } from "../src/react-app/domains/engenharia/obra/pages/obra-planejamento";
import { ObraServicos } from "../src/react-app/domains/engenharia/obra/pages/obra-servicos";
import { ObraVisaoGeral } from "../src/react-app/domains/engenharia/obra/pages/obra-visao-geral";
import { OBRA_MODELO_EAP_ID } from "../src/react-app/domains/engenharia/obra/obra-eap-data";
import { resetObraEapRepository } from "../src/react-app/domains/engenharia/obra/obra-eap-repository";
import type { Obra } from "../src/react-app/domains/engenharia/obra/obra-types";

const OBRA_MODELO: Obra = {
  id: OBRA_MODELO_EAP_ID,
  nome: OBRA_MODELO_EAP_ID,
  status: "PROPOSTA",
  caracterizacao: {
    torres: 1,
    lajes: 14,
    apartamentosPorPavimento: 1,
    subsolos: 0,
    sistemaConstrutivo: "concreto_armado",
  },
};

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
  resetObraEapRepository();
});

describe("KPI bars nos módulos principais (FASE 21) — derivados de dados reais", () => {
  test("Visão Geral: KPIs de caracterização + EAP", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ObraVisaoGeral obra={OBRA_MODELO} />
      </MemoryRouter>,
    );
    expect(html).toContain("data-kpi-bar");
    expect(html).toContain("data-kpi=\"kpi-torres\"");
    expect(html).toContain("data-kpi=\"kpi-lajes\"");
    expect(html).toContain("data-kpi=\"kpi-eap-nos\"");
    expect(html).toContain(">1<"); // torres
    expect(html).toContain(">14<"); // lajes
    expect(html).toContain(">81<"); // nós EAP
  });

  test("EAP: KPIs derivados dos 81 nós reais", () => {
    const html = renderToStaticMarkup(<ObraEap obra={OBRA_MODELO} />);
    expect(html).toContain("data-kpi-bar");
    expect(html).toContain("data-kpi=\"kpi-total\"");
    expect(html).toContain("data-kpi=\"kpi-disciplinas\"");
    expect(html).toContain("data-kpi=\"kpi-pacotes\"");
    expect(html).toContain("data-kpi=\"kpi-trabalhos\"");
    expect(html).toContain("data-kpi=\"kpi-folhas\"");
    expect(html).toContain(">81<"); // total
    expect(html).toContain(">10<"); // disciplinas
    expect(html).toContain(">24<"); // pacotes
    expect(html).toContain(">47<"); // trabalhos
  });

  test("Planejamento: KPIs de duração, críticos e sequenciais", () => {
    const html = renderToStaticMarkup(<ObraPlanejamento obra={OBRA_MODELO} />);
    expect(html).toContain("data-kpi-bar");
    expect(html).toContain("data-kpi=\"kpi-duracao\"");
    expect(html).toContain("data-kpi=\"kpi-criticos\"");
    expect(html).toContain("data-kpi=\"kpi-sequenciais\"");
  });

  test("Linha de Balanço: KPIs de semanas, serviços e críticos", () => {
    const html = renderToStaticMarkup(<ObraLobGrade obra={OBRA_MODELO} />);
    expect(html).toContain("data-kpi-bar");
    expect(html).toContain("data-kpi=\"kpi-semanas\"");
    expect(html).toContain("data-kpi=\"kpi-servicos\"");
    expect(html).toContain("data-kpi=\"kpi-criticos\"");
    expect(html).toContain(">100<"); // semanas
    expect(html).toContain(">34<"); // serviços
  });

  test("Serviços: KPIs de total, críticos e sequenciais", () => {
    const html = renderToStaticMarkup(<ObraServicos obra={OBRA_MODELO} />);
    expect(html).toContain("data-kpi-bar");
    expect(html).toContain("data-kpi=\"kpi-total\"");
    expect(html).toContain("data-kpi=\"kpi-criticos\"");
    expect(html).toContain("data-kpi=\"kpi-sequenciais\"");
    expect(html).toContain(">47<"); // total de trabalhos
  });
});
