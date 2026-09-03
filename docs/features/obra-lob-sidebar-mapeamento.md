# Mapeamento: Planilha EAP-Obra-Modelo → Sidebar do App OBRA-MODELO-EAP

> **Documento de decisão (proposta)** · Domínio Engenharia · 2026-09-03
> Objetivo: recriar a Linha de Balanço (LOB) **dentro** do app e adaptar a
> sidebar para seguir o **fluxo real de uma obra**, agrupada por **fases**,
> com as subdivisões interligadas pela mesma fonte de dados.

## 1. Contexto

A planilha `docs/EAP-Obra-Modelo.xlsx` foi gerada com **7 abas** nativas:

| # | Aba | Conteúdo |
| --- | --- | --- |
| 1 | `EAP` | 81 nós (10 DISCIPLINA / 24 PACOTE / 47 TRABALHO) |
| 2 | `Resumo` | KPIs e visão consolidada |
| 3 | `Disciplinas` | Visão por disciplina |
| 4 | `Serviços` | Visão por serviço |
| 5 | `Linha de Balanço` | Tabela de dados (datas, durações, críticos) |
| 6 | `PLANEJAMENTO` | Fonte única: datas dd/mm/yyyy, predecessoras, crítico |
| 7 | `LINHA DE BALANÇO (GRADE)` | Grade tempo × serviço com fórmulas SUMPRODUCT |

O app OBRA-MODELO-EAP já possui os módulos: **Visão Geral, EAP, Frentes,
Planejamento, Produção, RDO, IA**. A proposta é **espelhar as abas da planilha
na sidebar** como subdivisões interligadas, alimentadas pela **mesma fonte de
dados** (os 81 nós reais do EAP + datas de planejamento).

## 2. Princípio central: uma única fonte de dados

A planilha tem **uma fonte única** (aba `PLANEJAMENTO`) da qual todas as outras
abas derivam. O app deve seguir o mesmo princípio:

- **Fonte única:** os 81 nós reais em `obra-eap-data.ts` + as datas/durações de
  planejamento (hoje em `dados-eap.js` / aba `PLANEJAMENTO`).
- **Tudo o resto é derivado** (Resumo, Disciplinas, Serviços, LOB, Grade) — nunca
  uma segunda fonte de números.
- Isso já é o padrão do domínio (ver `obra-eap-repository.ts` → `deriveEapSummary`).

## 3. Mapeamento aba → módulo/subdivisão

| Aba da planilha | Fase | Subdivisão proposta | Estado |
| --- | --- | --- | --- |
| `Resumo` | Preparação | `visao-geral` | ✅ Existe |
| `EAP` | Preparação | `eap` | ✅ Existe |
| `Disciplinas` | Preparação | `disciplinas` (nova) | 🆕 Nova |
| `Serviços` | Preparação | `servicos` (nova) | 🆕 Nova |
| `PLANEJAMENTO` | Preparação | `planejamento` (fonte) | 🔧 Adapter |
| `Linha de Balanço` (dados) | Preparação | `planejamento` (dados) | 🔧 Adapter |
| `LINHA DE BALANÇO (GRADE)` | Preparação | `linha-de-balanco` (grade) | 🆕 Nova |

## 4. Estrutura da sidebar proposta (fluxo real da obra, por fases)

A sidebar segue o **ciclo de vida real de uma obra**, agrupada em **fases**
colapsáveis. Cada fase reúne os módulos que pertencem àquele momento da obra.

```
Engenharia
└── Obras
    └── Edifício Residencial Modelo EAP   (entidade)
        │
        ├── ▸ PREPARAÇÃO                    (grupo de fase)
        │     ├── Visão Geral        ← Resumo / cadastro
        │     ├── Caracterização     ← dados estruturais (torres, lajes, subsolos)
        │     ├── EAP                ← 81 nós (10/24/47)
        │     ├── Disciplinas        ← 10 disciplinas (derivado)
        │     ├── Serviços           ← 47 trabalhos (derivado)
        │     └── Planejamento       ← cronograma + Linha de Balanço (dados)
        │           └── Linha de Balanço (Grade)   ← grade tempo × serviço
        │
        ├── ▸ EXECUÇÃO                       (grupo de fase)
        │     ├── Frentes de Serviço  ← frentes físicas (futuro, ligado ao EAP)
        │     ├── Produção            ← avanço físico (futuro)
        │     └── RDO                 ← registro diário (futuro)
        │
        └── ▸ SUPORTE                       (grupo de fase)
              └── IA                  ← assistência (futuro)
```

> A sidebar já é **data-driven** (`NavigationNode` suporta `children` aninhados),
> então adicionar fases e subdivisões é uma mudança declarativa em
> `obra-navigation.ts`, sem tocar no Core de navegação. Cada fase é um nó
> agrupador (`type: "group"`) com os módulos como filhos.

## 5. O que cada subdivisão mostra

### 5.0 Fases (grupos da sidebar)

A sidebar organiza os módulos em **3 fases** do ciclo de vida da obra:

| Fase | Momento | Módulos |
| --- | --- | --- |
| **Preparação** | Antes/durante o planejamento | Visão Geral, Caracterização, EAP, Disciplinas, Serviços, Planejamento, Linha de Balanço |
| **Execução** | Durante a construção | Frentes, Produção, RDO |
| **Suporte** | Transversal | IA |

### 5.1 Visão Geral (existe)
Resumo da obra: status, caracterização. **Derivado** da fonte.

### 5.2 Caracterização (nova)
Dados estruturais da obra (torres, lajes, apartamentos por pavimento, subsolos,
sistema construtivo). Hoje vive dentro da Visão Geral; passa a ser um módulo
próprio na fase **Preparação**.

### 5.3 EAP (existe)
Árvore navegável dos 81 nós (10/24/47). **Fonte** da hierarquia.

### 5.4 Disciplinas (nova)
As 10 DISCIPLINA (nível 1) com seus pacotes/trabalhos agregados. Derivado dos nós.

### 5.5 Serviços (nova)
Os 47 TRABALHO (nível 3) com duração, datas, crítico. Derivado do planejamento.

### 5.6 Planejamento (adapter)
O `PlanningDashboard` existente (árvore + timeline/Gantt) alimentado pelos **81
nós reais** com datas — substituindo o `PLANNING_DEMO_DATA`. É a aba
`PLANEJAMENTO` + `Linha de Balanço` (dados) do Excel.

### 5.7 Linha de Balanço — Grade (nova)
A grade **tempo × serviço** (como a aba `LINHA DE BALANÇO (GRADE)`): 100 semanas,
81 serviços, células ativas quando o serviço está em execução. Renderizada em
React (não é imagem estática), derivada das mesmas datas.

## 6. Dados de planejamento (o que falta)

Hoje o app **não tem** as datas/durações de planejamento como dados de domínio.
Elas existem apenas no gerador da planilha (`dados-eap.js`) e na aba
`PLANEJAMENTO`. Para alimentar o app precisamos:

1. **Criar um modelo de planejamento da obra** (datas, durações, predecessoras,
   crítico) — espelhando a aba `PLANEJAMENTO`.
2. **Criar um adapter** que converte os 81 nós + datas em `PlanningDashboardData`
   (contrato do módulo `planejamento/`), substituindo o `PLANNING_DEMO_DATA`.
3. **Criar a grade LOB** em React, derivada das mesmas datas.

## 7. Impacto / arquivos

| Arquivo | Mudança |
| --- | --- |
| `obra-routes.ts` | Novos módulos: `caracterizacao`, `disciplinas`, `servicos`, `linha-de-balanco` |
| `obra-navigation.ts` | Fases (grupos) + subdivisões na sidebar (data-driven) |
| `obra-shell-route.tsx` | Rotear os novos módulos para as novas páginas |
| `obra-planejamento.tsx` | Adapter real (substitui demo) |
| `obra-eap-data.ts` | Fonte única (já existe) |
| `obra-planejamento-data.ts` (novo) | Datas/durações/predecessoras/crítico |
| `obra-planejamento-adapter.ts` (novo) | EAP + datas → `PlanningDashboardData` |
| `obra-lob-grade.tsx` (novo) | Grade tempo × serviço em React |
| `obra-disciplinas.tsx` / `obra-servicos.tsx` (novos) | Visões derivadas |
| `obra-caracterizacao.tsx` (novo) | Módulo próprio de caracterização |

## 8. Riscos / decisões em aberto

- **Escopo:** a proposta completa (fases + subdivisões + grade LOB + adapter) é um
  trabalho de várias etapas. Podemos entregar em fases.
- **Frentes/Produção/RDO/IA** continuam placeholders (futuro), mas já aparecem
  agrupados na fase **Execução** / **Suporte** para refletir o fluxo real.
- **Grade LOB em React** é uma nova visualização; o `PlanningDashboard` atual é
  Gantt (árvore + timeline). A grade LOB é um layout diferente (tempo × serviço),
  então será um componente novo, não uma extensão do Gantt.
- **Fonte de datas:** precisamos decidir se as datas de planejamento entram como
  dados de domínio persistidos (como a EAP) ou como seed estático derivado.
- **Caracterização** hoje vive dentro da Visão Geral; movê-la para módulo próprio
  muda a Visão Geral (que passa a ser só o resumo).

## 9. Próximo passo sugerido

1. Confirmar a estrutura da sidebar por fases (§4).
2. Implementar em fases:
   - **Fase A:** adapter real no Planejamento (substitui demo) + teste.
   - **Fase B:** fases/grupos na sidebar + subdivisões Disciplinas e Serviços.
   - **Fase C:** grade LOB em React.
3. Cada fase com teste em `apps/app/tests/` e evidência de execução.
