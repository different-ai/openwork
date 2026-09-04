# Proposta — Consolidação da Arquitetura Visual e Estrutural do Workspace (FASE 21)

> **Status: APROVADA (2026-09-03).** Decisões registradas na seção 9.
> Data: 2026-09-03 · Domínio: Engenharia · Obra: OBRA-MODELO-EAP

---

## 1. Contexto e objetivos

A implementação da **Opção B revisada** (FASE 20.x) foi aprovada. Antes de avançar para
Orçamento/Medição/Indicadores (que **não** serão implementados agora), o usuário pediu para
**consolidar a arquitetura visual e estrutural do Workspace**, para que os próximos módulos
sejam construídos sobre uma interface profissional e escalável de software de
planejamento/gestão de obras.

### Restrições inegociáveis (preservadas em toda a proposta)
1. **EAP real da obra preservada** — 81 nós (10 DISCIPLINA / 24 PACOTE / 47 TRABALHO).
2. **Dataset ARES/Piemarta isolado** como referência/demonstração — nunca como cronograma da obra real.
3. **Separação de fontes** mantida e explícita no modelo e na documentação.
4. **Domínio reutilizável** — toda nova capacidade desacoplada da interface e da obra ARES,
   para futuro multiobra e exposição via Skills/MCP a diferentes agentes de IA.

### Ordem de avanço (após a consolidação)
1. Consolidar a interface do Workspace (esta proposta).
2. Modelo **Serviço = EAP × Frente × Localização**.
3. Evoluir **Planejamento, Gantt, Rede/CPM, LOB e Produção**.

---

## 2. Diagnóstico do estado atual

### O que já está bem (a preservar)
- **Camada de domínio reutilizável de Planejamento** já existe em `domains/planejamento/`
  (`PlanningDashboard`, `PlanningTree`, `PlanningTimeline`, `PlanningDetails`, `PlanningHelp`,
  `planning-data.ts`, `planning-types.ts`). A página `ObraPlanejamento` é apenas um **adapter**
  (`obraEapParaPlanningDashboard`) que alimenta a dashboard genérica. **Este é o padrão-alvo.**
- **Separação de fontes** já implementada e testada (FASE 20.x): EAP real 81 nós + dataset
  ARES/Piemarta isolado em `obra-ares-referencia.ts`.
- **Navegação por fases** já existe na sidebar (`obra-navigation.ts` → `OBRA_FASES`).

### Lacunas / inconsistências visuais e estruturais
| # | Lacuna | Impacto |
|---|--------|---------|
| 1 | **Cabeçalho da obra mínimo** — o shell mostra só breadcrumb + nome + botões planos. Sem contexto da obra (status, datas, progresso, fase atual). | Falta identidade profissional de "software de gestão de obra". |
| 2 | **Layout de página ad-hoc** — cada módulo tem seu próprio padrão (Card+table, Card+grid). Sem um "shell de módulo" compartilhado. | Inconsistência visual; retrabalho a cada módulo novo. |
| 3 | **LOB acoplada ao domínio Obra** — `obra-lob-grade.tsx` é auto-contida e dependente da EAP da obra. Não é reutilizável. | Viola o princípio de domínio reutilizável. |
| 4 | **Sem barra de contexto/KPIs consistente** — cada módulo decide se mostra resumo. | Falta visão executiva padronizada. |
| 5 | **Nav interna plana** — o shell usa botões planos, ignorando o agrupamento por fase já definido na sidebar. | Duas navegações divergentes. |
| 6 | **Frentes/Produção simples** — tabelas básicas, sem o modelo Serviço = EAP × Frente × Localização. | Base fraca para a próxima fase. |

---

## 3. Princípios de arquitetura (norteadores)

1. **Domínio reutilizável primeiro, UI depois.** Cada capacidade (Planejamento, LOB, Rede/CPM,
   Serviços, Produção) vive em um domínio próprio (`domains/<capacidade>/`) com:
   - **Contrato de tipos** (`*-types.ts`) — genérico, sem conhecer Obra nem ARES.
   - **Lógica pura** (`*-data.ts`) — funções puras, testáveis, sem React.
   - **Componentes de apresentação** (`*-dashboard.tsx`, `*-tree.tsx`, etc.) — renderizam qualquer
     dado que satisfaça o contrato.
   - **Adapter por domínio consumidor** — o domínio Engenharia traduz sua entidade para o contrato.
2. **Obra é um domínio consumidor, não o dono das capacidades.** `domains/engenharia/obra/`
   orquestra e adapta; as capacidades vivem fora.
3. **Multiobra e Skills/MCP prontos.** Como o contrato é genérico, a mesma capacidade pode ser
   alimentada por qualquer obra (multiobra) e exposta via Skills/MCP a agentes de IA.
4. **Separação de fontes explícita.** Obra real e ARES/Piemarta nunca se misturam; o dataset de
   referência fica isolado e rotulado.
5. **Menor diff possível.** Reutilizar o que já existe; não reescrever o que funciona.

---

## 4. Proposta de arquitetura visual (Workspace)

### 4.1 Shell da Obra (cabeçalho + navegação + conteúdo)
Um **shell de obra profissional** com três zonas:

```
┌──────────────────────────────────────────────────────────────────────┐
│  Engenharia · Obra                                    [Ajuda] [Ações] │  ← breadcrumb
│  OBRA-MODELO-EAP-001  ·  Status PROPOSTA  ·  Início 05/01/2026       │  ← identidade
│  ┌──────────┬──────────┬──────────┬──────────┬──────────┬─────────┐  │
│  │ Preparação: Visão Geral · Caracterização · EAP · Disciplinas ·  │  │  ← nav por fase
│  │ Serviços · Planejamento · LOB                                    │  │
│  │ Execução: Frentes · Produção · RDO   Suporte: IA                 │  │
│  └──────────┴──────────┴──────────┴──────────┴──────────┴─────────┘  │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  [KPI] [KPI] [KPI] [KPI]   ← barra de contexto do módulo      │  │
│  │  Conteúdo do módulo ativo                                       │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

- **Zona 1 — Identidade da obra**: nome, status, datas (início/fim), fase atual. Reutiliza dados
  já existentes (`obra.caracterizacao`, `DATA_INICIO_OBRA`, `duracaoTotal`).
- **Zona 2 — Navegação por fase**: agrupada por `OBRA_FASES` (Preparação / Execução / Suporte),
  alinhada à sidebar. Substitui os botões planos atuais.
- **Zona 3 — Conteúdo do módulo**: cada módulo renderiza dentro de um **shell de módulo**
  compartilhado (ver 4.2).

### 4.2 Shell de módulo compartilhado
Um componente `ObraModuleShell` que padroniza: título, descrição, barra de KPIs opcional e
conteúdo. Todos os módulos passam a usar o mesmo esqueleto → consistência visual imediata.

### 4.3 Barra de contexto / KPIs
Um componente `ObraKpiBar` reutilizável que cada módulo alimenta com seus indicadores
(ex.: EAP → 81 nós / 10 disciplinas / 24 pacotes / 47 trabalhos; LOB → 100 semanas / 34 serviços /
6 críticos). Padroniza a "visão executiva" de cada módulo.

---

## 5. Proposta de arquitetura estrutural (domínios reutilizáveis)

### 5.1 Extrair a LOB para um domínio reutilizável
Criar `domains/linha-de-balanco/` (espelhando o padrão de `domains/planejamento/`):
- `lob-types.ts` — contrato genérico: `LobData` (semanas, linhas, células ativas, crítico).
- `lob-data.ts` — lógica pura (gerar semanas, derivar grade) — **movida** de `obra-lob-data.ts`.
- `lob-grade.tsx` — componente de apresentação genérico.
- `obra-lob-adapter.ts` — traduz a EAP real da obra para `LobData`.

**Resultado**: a LOB deixa de ser acoplada à obra; qualquer obra (ou o dataset ARES) pode
alimentá-la. A obra real continua usando a EAP real; o dataset ARES pode validar a estrutura.

### 5.2 Padronizar o domínio de Serviços (base para a próxima fase)
Criar o contrato genérico de **Serviço = EAP × Frente × Localização** em um domínio próprio
(`domains/servicos/`), ainda sem UI completa — apenas tipos + lógica pura + testes. Isso prepara
a FASE 22 sem acoplar à obra.

### 5.3 Manter Planejamento como está (já reutilizável)
`domains/planejamento/` já segue o padrão. Apenas garantir que o adapter da obra real continue
alimentando-o com a EAP real (sem mudança funcional).

### 5.4 Camada de exposição (Skills/MCP) — preparação
Documentar o contrato de cada capacidade para que, no futuro, sejam expostas via Skills/MCP.
**Não implementar** a exposição agora — apenas deixar os contratos limpos e documentados.

---

## 6. Escopo desta FASE 21 (o que será implementado após aprovação)

### 6.1 Interface (visual)
- [ ] **Shell da obra** profissional (identidade + nav por fase + conteúdo).
- [ ] **Shell de módulo** compartilhado (`ObraModuleShell`).
- [ ] **Barra de KPIs** reutilizável (`ObraKpiBar`).
- [ ] Aplicar o shell aos módulos existentes (Visão Geral, EAP, Disciplinas, Serviços,
      Planejamento, LOB, Frentes, Produção) — **sem mudar os dados nem a lógica**.

### 6.2 Estrutura (domínios reutilizáveis)
- [ ] Extrair **LOB** para `domains/linha-de-balanco/` (tipos + lógica + componente + adapter).
- [ ] Criar contrato genérico de **Serviços** (`domains/servicos/`) — tipos + lógica + testes
      (base da FASE 22), **sem UI completa**.

### 6.3 Garantias
- [ ] EAP real de 81 nós **intacta** (nenhuma alteração em `obra-eap-data.ts`).
- [ ] Dataset ARES/Piemarta **isolado** e rotulado (nenhuma alteração em `obra-ares-referencia.ts`).
- [ ] Separação de fontes **mantida** e coberta por testes.
- [ ] `pnpm typecheck` limpo + testes `obra-*` verdes em isolamento.

### 6.4 Fora de escopo (NÃO implementar agora)
- ❌ Orçamento, Medição, Indicadores.
- ❌ Exposição real via Skills/MCP (apenas contratos limpos e documentados).
- ❌ Expansão da EAP para 20 disciplinas (a EAP real de 81 nós é preservada).

---

## 7. Impacto em arquivos

| Ação | Arquivo |
|------|---------|
| Novo | `domains/linha-de-balanco/lob-types.ts`, `lob-data.ts`, `lob-grade.tsx` |
| Novo | `domains/servicos/servicos-types.ts`, `servicos-data.ts` |
| Novo | `domains/engenharia/obra/obra-lob-adapter.ts` |
| Novo | `domains/engenharia/obra/components/obra-module-shell.tsx`, `obra-kpi-bar.tsx` |
| Editar | `obra-shell-route.tsx` (nav por fase + identidade) |
| Editar | `obra-lob-data.ts` → delegar a `domains/linha-de-balanco` (ou mover) |
| Editar | páginas de módulos para usar `ObraModuleShell` (sem mudar dados) |
| Editar | `docs/features/mapeamento-ares-app.md` (registrar FASE 21) |
| Testes | novos testes para LOB reutilizável, Serviços, e shell |

---

## 8. Riscos e mitigação

| Risco | Mitigação |
|-------|-----------|
| Quebrar a EAP real ao refatorar | Nenhuma alteração em `obra-eap-data.ts`; testes de regressão da EAP (81 nós) |
| Perder a separação de fontes | Dataset ARES isolado e rotulado; testes de separação existentes mantidos |
| Refatoração da LOB introduzir bug | Mover lógica pura com testes; adapter testado com a EAP real |
| Escopo crescer demais | FASE 21 limitada a shell + LOB reutilizável + contrato de Serviços; Orçamento/Medição/Indicadores fora |

---

## 9. Decisões que preciso de você

1. **Escopo da FASE 21** — concorda com o corte acima (shell + LOB reutilizável + contrato de
   Serviços, sem Orçamento/Medição/Indicadores)?
2. **Nav interna** — prefere **abas por fase** (Preparação/Execução/Suporte com sub-itens) ou
   **uma linha única de módulos** com separadores de fase (mais compacto)?
3. **Barra de KPIs** — quer KPIs em **todos** os módulos ou apenas nos principais
   (Visão Geral, EAP, Planejamento, LOB)?
4. **Extração da LOB** — mover a lógica para `domains/linha-de-balanco/` (recomendado) ou manter
   em `obra-lob-data.ts` e apenas criar o componente genérico?

---

## 10. Decisões aprovadas (2026-09-03)

| # | Decisão | Escolha |
|---|---------|---------|
| 1 | Escopo da FASE 21 | **Aprovado o escopo completo** (shell + LOB reutilizável + contrato de Serviços; Orçamento/Medição/Indicadores e exposição Skills/MCP fora) |
| 2 | Navegação interna | **Abas por fase com sub-itens** (Preparação/Execução/Suporte com os módulos de cada fase) |
| 3 | Barra de KPIs | **Nos módulos principais** (Visão Geral, EAP, Planejamento, LOB, Serviços) |
| 4 | Extração da LOB | **Mover para `domains/linha-de-balanco/`** (tipos + lógica + componente) com adapter da obra real |

**Aguardando sua aprovação e respostas às decisões acima. Nenhuma interface foi alterada.**
