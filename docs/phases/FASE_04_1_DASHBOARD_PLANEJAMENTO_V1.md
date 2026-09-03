# FASE 04.1 — DASHBOARD DE PLANEJAMENTO V1 (UI nativa do OpenWork)

> **Data:** 2026-01-09 · **Tipo:** implementação de superfície reutilizável de planejamento.
> **Escopo:** clone `OPENWORK-LAB\openwork`. **Sem Gantt/CPM/Rede/LOB/motor de dependências.**

## 1. Objetivo
Substituir o placeholder do módulo `planejamento` da Obra por uma **Dashboard de
Planejamento V1** nativa e **reutilizável** (capacidade genérica), consumida pelo
domínio de Engenharia via um adapter, sem acoplar o componente a uma obra.

## 2. Estado anterior
- Rota `/dominios/engenharia/obras/OBRA-MODELO-EAP-001/planejamento` renderizava
  `ObraModuloPlaceholder` ("Módulo em construção").
- Não existia modelo, dados, componente de timeline nem dashboard no OpenWork.
- Auditorias read-only (FASE 04.0 e 04.0.1) mapearam o motor Python do Obra
  Copilot/ARES (`Agent/planning/*`) como **referência de regras/contratos**.

## 3. Problema identificado
Usuários entram no módulo Planejamento e encontram tela vazia/placeholder, sem
estrutura, período, indicadores, pontos de atenção ou ajuda contextual.

## 4. Arquitetura adotada
```text
PlanningDashboardData (contrato genérico)
        ↓
Planning Dashboard (capacidade reutilizável)
        ↓
Consumer/Adapter do domínio (ObraPlanejamento)
```
- **Capacidade genérica** vive em `domains/planejamento/` (neutra; não conhece
  nenhum domínio). **Consumer** vive em `domains/engenharia/obra/pages/`.
- A capacidade não depende de router/sidebar/domínio; renderiza qualquer
  `PlanningDashboardData`.

## 5. Contrato `PlanningDashboardData`
```ts
type PlanningDashboardData = {
  context: { title: string; subtitle?: string; referenceDate?: string };
  items: PlanningItem[];
  periods?: PlanningPeriod[]; // opcional; derivado dos itens quando ausente
};
```

## 6. Contrato `PlanningItem`
```ts
type PlanningItem = {
  id: string;
  parentId?: string | null;
  name: string;
  level: number;                 // 0 = raiz
  status: "planejado" | "em_andamento" | "atrasado" | "concluido";
  progress: number;              // 0..100
  start?: string | null;         // ISO yyyy-mm-dd (inclusive)
  end?: string | null;           // ISO yyyy-mm-dd (inclusive)
};
```
Ausência de `start/end` é permitida e vira alerta "sem período" (apenas para
itens folha).

## 7. Estrutura de arquivos
```
apps/app/src/react-app/domains/planejamento/      (capacidade genérica)
├── planning-types.ts          contratos
├── planning-data.ts           helpers puros (resumo/alertas/períodos/linhas/busca)
├── planning-demo-data.ts      dataset demonstrativo neutro (determinístico)
├── planning-help.tsx          ajuda contextual (Popover nativo)
├── planning-dashboard.tsx     superfície integrada (header/KPIs/árvore+timeline/alertas/Sheet)
├── planning-tree.tsx          árvore hierárquica (expand/recolher/seleção)
├── planning-timeline.tsx      timeline simples (barras por data, eixo mensal)
└── planning-details.tsx       painel de detalhes do item (lido pelo Sheet)

apps/app/src/react-app/domains/engenharia/obra/
├── pages/obra-planejamento.tsx   consumer/adapter (contexto + dados demo)
└── obra-shell-route.tsx          modificado: ramo "planejamento" usa ObraPlanejamento

apps/app/tests/                  testes (unit + SSR + anti-hardcode)
docs/phases/FASE_04_1_DASHBOARD_PLANEJAMENTO_V1.md   este documento
```
## 8. Componentes criados (IMPLEMENTADO)
- `PlanningDashboard` — superfície: header + contexto + ajuda ⓘ; 4 KPIs
  derivados (Total, Em andamento, Atenção, Concluídos); busca por nome; painel
  Árvore+Timeline com rolagem vertical sincronizada; alertas derivados; Sheet de
  detalhes; estado vazio (`Empty`).
- `PlanningTree` — árvore hierárquica por `parentId`, expandir/recolher,
  seleção, indentação por `level`, `role="tree/treeitem"` (acessibilidade).
- `PlanningTimeline` — eixo mensal e barras por item derivadas de `start/end`
  (largura proporcional a dias; scroll horizontal no contêiner). Sem drag/resize.
- `PlanningHelp` — Popover nativo com perguntas/respostas da V1.
- `PlanningItemDetails` — campos: Nome, Status, Progresso, Início, Fim, Nível, Pai.
- `ObraPlanejamento` — adapter do domínio (contexto + dataset demo).

## 9. Componentes reutilizados (IMPLEMENTADO)
`Button`, `Card`, `Badge`, `Input`, `Empty`, `Sheet`, `Popover`, `Progress`
(`components/ui/*`), `cn`, `lucide-react`, Tailwind v4. **Não** usamos
`@pierre/trees` na V1 (decisão documentada): a árvore mínima exigida (expansão
por id + seleção + indentação) é atendida com componentes nativos simples e
testáveis, evitando difundir a dependência beta por toda a arquitetura.

## 10. Decisões de design
- Linhas derivadas em ordem de árvore compartilhadas 1:1 entre árvore e timeline
  (alturas fixas) → alinhamento garantido sem estado duplicado.
- KPIs/alertas/períodos **derivados** por helpers puros (`planning-data.ts`).
- Data de referência do contexto controla os alertas de atenção (determinístico).
- Estados de UI (colapso, seleção, busca) locais via `useState` — sem persistência.
- Scroll vertical sincronizado por refs entre as duas colunas (V1).

## 11. Decisões de não adicionar dependências
Não instalada nenhuma biblioteca (nenhuma de Gantt/calendário/gráfico/drag).
Preferência: `@pierre/trees` NÃO usada (ver §9); `react-resizable-panels` NÃO
usado (layout CSS atende a V1; pode entrar em fase futura).

## 12. Relação com o futuro Planning Engine
```text
Obra Copilot / ARES → PlanningEngine existente → referência de regras/contratos
OpenWork → Planning Dashboard V1 → dados demonstrativos
OpenWork ─X─> Python PlanningEngine          (sem runtime bridge — decisão)
```
O contrato V1 foi inspirado nas estruturas do ARES (`PlanningActivity`:
activity_id/parent/status/datas; `EapItem`) mas **não duplica** o motor: nesta
fase não há dependências/CPM/calendário de dias úteis nem auto-agendamento.

## 13. Deliberadamente NÃO implementado (FORA DE ESCOPO nesta fase)
Predecessor/successor/dependencyType/FS/SS/FF/SF/lag/lead/criticalPath/float/
resourceAllocation/baseline/produção/medição; Gantt completo; CPM; Rede; LOB;
auto-scheduling; drag/resize; integração Python/Excel; persistência de dados;
EAP real; IA. (FUTURO)
## 14. Testes (IMPLEMENTADO — executados)
- `tests/planning-data.test.ts` (9 testes) — datas, resumo, alertas, linhas/pré-order,
  colapso, raízes, busca, períodos, daysBetween.
- `tests/planning-dashboard.test.tsx` (6 testes) — SSR: título/contexto/KPIs,
  árvore+timeline, alertas, estado vazio, painel de detalhes, conteúdo de ajuda.
- `tests/planning-anti-hardcode.test.ts` (3 testes) — auditoria anti-hardcode da pasta genérica.

## 15. Typecheck (PASS)
`pnpm --filter @openwork/app typecheck` → exit 0.

## 16. Build (PASS)
`pnpm --filter @openwork/app build` → ✓ built (warnings pré-existentes de chunk).

## 17. Auditoria anti-hardcode (PASS)
- A pasta `domains/planejamento/` não contém: `OBRA-MODELO-EAP-001`, `torre`,
  `apartamento`, `pavimento`, `engenharia`, `obra-001` (verificado por teste e
  por revisão). O único contexto de obra entra em runtime pelo consumer
  (`obra.nome`), nunca hardcoded no componente.

## 18. Limitações conhecidas (FUTURO / aceitas na V1)
- Timeline é visual simples (sem drag/resize/zoom); scroll horizontal move a
  coluna da timeline (a árvore permanece fixa à esquerda no desktop).
- Alertas: derivados de status/datas/progresso; sem motor de diagnóstico.
- Dados demonstrativos substituíveis pelo adapter em fase futura.
- Barra de busca por nome; filtro por status é FUTURO (decisão de não
  adicionar complexidade nesta fase).

## 19. Próximos passos (não implementados nesta fase)
1. Adapter real de `PlanningDashboardData` a partir da entidade do domínio
   (vincular itens a nós de EAP/obra quando a fonte real for integrada).
2. Porta TS das regras do PlanningEngine ARES (Q/P, FS/SS/FF, calendário) com
   paridade de testes — sem runtime bridge.
3. Dependências/CPM/LOB e timeline interativa em fases futuras, mantendo a
   superfície integrada (Árvore · Timeline · Resumo · Alertas · Detalhes · IA).

## Verificação final da fase
- [x] placeholder substituído · [x] Dashboard nativa · [x] componente reutilizável
- [x] sem hardcode no componente · [x] KPIs · [x] árvore · [x] timeline · [x] seleção/detalhes
- [x] alertas · [x] ajuda contextual · [x] estado vazio · [x] testes · [x] typecheck
- [x] build · [x] documentação · [x] anti-hardcode · [x] sem dependências novas
- [x] sem Gantt/CPM/LOB · [x] sem alterações indevidas no Core


