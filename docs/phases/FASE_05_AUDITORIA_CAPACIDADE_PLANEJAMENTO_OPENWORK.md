# FASE 05 — AUDITORIA DE CAPACIDADE DE PLANEJAMENTO DO OPENWORK (read-only)

> **Data:** 2026-01-09 · **Tipo:** auditoria — comparativo OpenProject/GanttReady (referências de requisitos).
> **Nenhum código alterado.** EAP existente não será reconstruída.

## 1. Objetivo
Verificar se a estrutura atual do OpenWork sustenta um planejamento de obras
profissional, absorvendo requisitos de OpenProject (verificado) e GanttReady
(referência conceitual — ver §6) **sem copiar** arquitetura/código/interface.

## 2. Escopo
Código do clone (`apps/app/src`, domínios `engenharia`/`planejamento`, Core) +
referência externa OpenProject (docs oficiais) + conceitos de Gantt profissional.

## 3. Metodologia
Inspeção de código (read-only), testes existentes executados (60 PASS/0 FAIL),
fetch de documentação externa. Toda capacidade interna aponta o arquivo onde está.

## 4. Arquitetura atual encontrada [CONFIRMADO]
- Core genérico (registry/navegação/roteamento) → domínio Engenharia → entidade
  Obra → módulos (rota `/dominios/engenharia/obras/:obraId/:modulo`).
- Módulos da obra encontrados (`obra-routes.ts` `OBRA_MODULES`): Visão Geral · EAP ·
  Frentes de Serviço · Planejamento · Produção · RDO · IA.
- Capacidade genérica de planejamento em `domains/planejamento/*` (contratos +
  dashboard demo) consumida por `obra-planejamento.tsx`.

## 5. Modelo operacional encontrado (inventário real)
| Conceito | Onde | Responsabilidade | Entidade | Persistência | Consumidores | Status |
|---|---|---|---|---|---|---|
| Obra | `engenharia/obra/obra-types.ts` + `obra-repository.ts` | entidade central; lista/cria | `Obra` | local (storage) | navegação, páginas | IMPLEMENTADO (V1) |
| EAP | `obra.eap` (resumo 10/24/47) em seed; módulo EAP mostra resumo | eixo estrutural (resumo) | `ObraEapSummary` | local (seed) | página EAP | PARCIAL — nós reais futuros (fonte isolada) |
| Serviços | — | — | — | — | — | NÃO ENCONTRADO no clone |
| Atividades (plano) | `domains/planejamento/planning-types.ts` | itens da timeline demo | `PlanningItem` | código (demo) | Dashboard V1 | DEMO (não é entidade persistida) |
| Predecessoras/Rede | — | — | — | — | — | NÃO ENCONTRADO no clone (existe no ARES Python, externo) |
| Calendário | — (helpers de datas simples em `planning-data.ts`) | período mensal p/ eixo | — | — | timeline | NÃO ENCONTRADO (dias úteis ausentes) |
| Duração | — | — | — | — | — | NÃO ENCONTRADO |
| Recursos/Equipes | — | — | — | — | — | NÃO ENCONTRADO |
| Produção/Medição/Controle/Indicadores | módulos `producao`,`rdo` placeholders | visão "em construção" | — | — | — | PLACEHOLDER |
| Frentes de Serviço | módulo `frentes` placeholder | visão | — | — | — | PLACEHOLDER |
| Histórico/Replanejamento | — | — | — | — | — | NÃO ENCONTRADO |
| Progresso | `PlanningItem.progress` (demo) + status | UI demo | campo | código | Dashboard | DEMO |
| Produtividade | — | — | — | — | — | NÃO ENCONTRADO |
| Memória/contexto da obra | sem repositório de contexto além de `obraId` (URL) | contexto | — | URL | páginas | MINIMAL (só obraId) |

Nota: quantidade/produtividade/FS-SS-FF/calendário/Gantt/LOB existem **apenas no motor
Python do Obra Copilot/ARES** (fora do clone; auditoria 04.0.1) — referência de regras,
sem bridge. Não há duplicidade interna de atividade/datas/duração no clone (ainda não
existem como entidades).
## 6. Auditoria da EAP [CONFIRMADO]
- Existe como **resumo** no modelo (`ObraEapSummary`) e como **módulo** que exibe o
  resumo real (10/24/47 → 81 nós, PROPOSTA) SEM os nós individuais (fonte isolada =
  FUTURO) — `obra-eap.tsx`.
- Não há árvore de nós EAP persistida no clone; não há geração de atividades a partir
  da EAP. EAP em 1ª classe existe apenas no ARES Python (referência).
- **Decisão:** a EAP existente não é reconstruída; ela evoluirá adicionando os nós reais
  (fonte) e vínculos por `obraId`/serviço em fases futuras.

## 7. Auditoria do planejamento
- Capacidade genérica V1 (`domains/planejamento`): Dashboard com **demo data** neutra,
  KPIs derivados, árvore (grupo→pacote→atividade) e timeline simples derivada de
  start/end. Consumida por `ObraPlanejamento` (contexto = `obra.nome`).
- **Não** há: motor de datas determinístico (Q/P, dias úteis), dependências, CPM/Gantt,
  baseline, produção real. A timeline é visualização simples (não é Gantt nem segunda
  fonte de dados).

## 8. Comparação com OpenProject (referência de requisitos — docs oficiais)
Capacidades do OpenProject (verificadas no índice da user guide de Work packages):
Work packages (tipos: task/feature/bug/phase/milestone), tabela/split/detalhes,
datas e duração, agendamento automático e manual (scheduling), relações e
hierarquias, baseline comparison, Gantt, calendário, progresso, gestão de recursos,
filtros/agrupamento/exportação, atividade/histórico. → Requisitos absorvíveis para
obra: hierarquia EAP/serviço/atividade, relações, baseline planejado×realizado,
scheduling, calendário, progresso e histórico.

## 9. Comparação com GanttReady [NÃO VERIFICADO — referência conceitual]
Não foi possível acessar fonte primária confiável do produto "GanttReady" (sem
resultados utilizáveis). A comparação usa **conceitos de domínio** típicos de um
planejador/Gantt profissional: tarefas hierárquicas, dependências, durações,
calendário/datas, caminho crítico/folgas, baseline, edição temporal — tratados como
**requisitos de domínio**, não como características afirmadas do produto.

## 10. Matriz consolidada
| Capacidade | OpenWork (clone) | OpenProject | GanttReady* | Situação | Decisão |
|---|---|---|---|---|---|
| EAP | 🟡 resumo (nós futuros) | 🟡 fases/estruturas configuráveis | 🟡 tarefas hierárquicas | PARCIAL | 🔵 evoluir nós EAP + vínculo obra |
| Serviços | 🔴 | ✅ WP/tipos | 🟡 | AUSENTE | 🔵 entidade serviço por obra |
| Atividades | 🟡 demo | ✅ | ✅ | PARCIAL | 🔵 entidade atividade real (modelo obra) |
| Hierarquia | ✅ árvore data-driven | ✅ | ✅ | ATENDE | ✅ reutilizar |
| Predecessoras | 🔴 (ARES py fora) | ✅ | ✅ | AUSENTE no clone | 🔵 rede na entidade |
| Sucessoras | 🔴 | ✅ | ✅ | AUSENTE | 🔵 |
| Rede de precedências | 🔴 | ✅ | ✅ | AUSENTE | 🔵 estrutura de relações |
| Calendário | 🔴 (dias úteis) | ✅ | ✅ | AUSENTE | 🔵 calendário por obra |
| Duração | 🔴 | ✅ | ✅ | AUSENTE | 🔵 duração derivada (Q/P) |
| Marcos | 🔴 | ✅ | ✅ | AUSENTE | 🔵 tipo de atividade/marco |
| Restrições | 🔴 | 🟡 | 🟡 | AUSENTE | 🔵 restrições de datas |
| CPM | 🔴 | 🟡 (não nomeado; scheduling) | 🟡 | AUSENTE | 🔵 cálculo sobre a rede |
| Caminho crítico | 🔴 | 🟡 | ✅ | AUSENTE | 🔵 derivado (cálculo) |
| Folgas | 🔴 | 🔴/🟡 | 🟡 | AUSENTE | 🔵 |
| Gantt | 🟡 timeline simples demo | ✅ | ✅ | PARCIAL | 🔵 Gantt = visualização do plano (não 2ª fonte) |
| Baseline | 🔴 | ✅ | ✅ | AUSENTE | 🔵 planejado × realizado |
| Progresso | 🟡 demo | ✅ | ✅ | PARCIAL | 🔵 status + % + produção real |
| Planejado × realizado | 🔴 | ✅ | ✅ | AUSENTE | 🔵 |
| Recursos | 🔴 | ✅ | 🟡 | AUSENTE | 🔵 equipes/produtividade por obra |
| Produtividade | 🔴 | 🔴/⚪ | 🟡 | AUSENTE | 🔵 (domínio engenharia) |
| Frentes de Serviço | 🟡 módulo placeholder | 🔴/⚪ | 🔴/⚪ | PARCIAL | 🔵 capacidade sobre atividade+local |
| Produção | 🔴 placeholder | 🟡 | 🔴/⚪ | AUSENTE | 🔵 registrar produção real |
| Medição | 🔴 | 🟡 | 🔴/⚪ | AUSENTE | 🔵 |
| Controle | 🔴 | 🟡 | 🟡 | AUSENTE | 🔵 indicadores derivados |
| Histórico | 🔴 | ✅ | 🟡 | AUSENTE | 🔵 versões/auditoria |
| Restrições operacionais | 🔴 | 🟡 | 🟡 | AUSENTE | 🔵 |
| Replanejamento | 🔴 | 🟡 (baseline) | 🟡 | AUSENTE | 🔵 versão + justificativa |
| Memória da Obra | 🔴 (só obraId) | 🟡 | 🟡 | AUSENTE | 🔵 contexto estruturado |
| Integração com IA | 🟡 espaço (domínio/capacidade) | 🟡 | 🔴 | FUTURO | 🔵 Agente Planejador sobre modelo |
*GanttReady = referência conceitual (não verificado como produto).
## 11. Fonte única da verdade [CONFIRMADO — sem duplicidade no clone]
- No clone não há duplicidade de atividade/datas/duração porque **ainda não existem como
  entidades persistidas** (só demo UI + resumo EAP). Riscos de duplicação apareceriam se
  cada visão futura (Gantt/LOB/Frente/Produção) mantivesse dados próprios — a decisão é:
  **um único modelo operacional da obra** e as ferramentas como **derivações** (Gantt =
  visualização do plano; CPM = cálculo sobre a rede; LOB = análise de repetitivo; Frente =
  execução de atividade em local; Produção = realizado). Fonte: princípio já usado pela
  capacidade `planejamento` (períodos/KPIs/alertas derivados) e pelo ARES (Gantt derivado).

## 12. Frentes de Serviço — capacidade estrutural
- Hoje: módulo placeholder (`obra-shell-route` → `ObraModuloPlaceholder`).
- Mínimo futuro no modelo de planejamento para a Frente operar: entidade **Atividade**
  com `obraId`, serviço, local/área (pavimento/unidade/frente), quantidades,
  produtividade/equipe, janela de datas (planejado), e um canal de **Produção Real**
  (quantidade/dia + data) para comparação planejado×realizado, geração de sinais de
  atraso e histórico. Nada disso existe hoje (modelo não estruturalmente capaz ainda —
  LACUNA IMPORTANTE).

## 13. Agente Planejador futuro
- Espaço arquitetural existe: capacidade genérica + domínio com entidade e URL de
  contexto; o Core permanece intacto. O agente (futuro) deve operar sobre o **modelo
  operacional da obra** (EAP/serviços/atividades/rede/calendário/produção/histórico) —
  exigirá antes a criação desse modelo. Não criar arquitetura artificial agora.

## 14. Lacunas
### CRÍTICAS
1. Sem entidade **Atividade/Serviço** persistida (base de tudo).
2. Sem **predecessoras/rede** e sem **motor de datas determinístico** (Q/P, dias úteis).
### IMPORTANTES
3. Sem **calendário** (dias úteis/feriados) por obra.
4. Sem **baseline/planejado×realizado** e **histórico**.
5. Sem canal de **produção real/medição** para controle.
6. Nós EAP individuais ainda não integrados (fonte isolada).
### FUTURAS
7. CPM/caminho crítico/folgas; Gantt profissional; LOB; recursos/equipes; indicadores;
   memória da obra; Agente Planejador.
### NÃO NECESSÁRIAS (não copiar por existir nas referências)
- Work-package como metáfora genérica (o domínio exige EAP→Serviço→Atividade→Frente);
- Tipos configuráveis estilo bug/feature; custos financeiros de projeto (fora do modelo
  atual da obra); fluxo Agile/Kanban.

## 15. Conhecimento absorvido
### OpenProject
- Modelo hierárquico de trabalho + relações explícitas (predecessoras/sucessoras);
  scheduling automático vs manual; baseline (comparação ao longo do tempo); progresso +
  atividades/histórico; Gantt como visão derivada; calendário. [REQUISITO]
### GanttReady (referência conceitual)
- Interação de Gantt profissional: dependências, durações, datas, caminho crítico/
  folgas, edição temporal e atualização do plano. [REQUISITO DE DOMÍNIO]
### OpenWork (diferenciais)
- Estrutura **Core→Domínio→Entidade** com EAP real como eixo e Obra como contexto por
  URL; navegação data-driven; capacidade de planejamento já derivativa; regras de obra
  (Q/P, FS/SS/FF, calendário) já desenhadas no ARES (referência de paridade).
### Não absorver
- Metáfora genérica de Work Package; tipos configurais de produto; custos financeiros
  abstratos; lógica de produto das referências.

## 16. Riscos
- Criar modelos paralelos (Gantt/LOB/Frente cada um com dados próprios) — mitigar com
  modelo operacional único e derivações.
- Implementar módulos antes de existir a **entidade atividade/planejamento persistida**.
- Adicionar "features" de referência sem vínculo com o domínio (fragmentação).

## 17. Roadmap recomendado (baseado nas lacunas)
1. **Modelo operacional da obra V1**: entidades `Serviço`/`Atividade` (obraId, hierarquia,
   quantidade, produtividade, local/frente, datas planejadas, status) persistidas no
   repositório do domínio.
2. **Planejamento real**: motor de datas determinístico (Q/P → duração; calendário dias
   úteis; FS/SS/FF+lag) portado/adaptado dos contratos ARES para TS (paridade de testes).
3. **Rede + CPM**: predecessoras/sucessoras, detecção de ciclo, forward pass, caminho
   crítico/folgas.
4. **Visualização**: Gantt derivado do plano (timeline profissional) — nunca 2ª fonte.
5. **Frente de Serviço → Produção**: executar atividade planejada em local, registrar
   produção real, medir planejado×realizado, gerar sinais.
6. **Controle/histórico**: baseline e versões, indicadores, histórico da obra.
7. **Inteligência**: memória da obra estruturada + Agente Planejador (analisar,
   diagnosticar, propor, justificar; sem alteração automática sem decisão humana).
Ordem baseada em dependência de dados (entidades → cálculo → visão → execução →
controle → IA).

## 18. Conclusão
O OpenWork ainda NÃO possui capacidade profissional de planejamento de obras no clone:
existem a casca arquitetural (Core/Domínio/Obra), a capacidade visual V1 com dados demo e
o repositório de obras; faltam as **entidades e o motor** do planejamento (lacunas
críticas). A arquitetura permite evoluir sem quebrar o Core; a EAP existente é o eixo e
será ampliada (nós reais), não reconstruída.

## 19. Veredito
**APROVADO COM RESSALVAS** — a auditoria e a arquitetura (espaço para o modelo) estão
adequadas, mas o planejamento profissional exige criar o modelo operacional e o motor
antes de Gantt/CPM/LOB/Frente/Produção (lacunas críticas identificadas).

## 20. Execução da fase
Testes executados: **60 PASS / 0 FAIL** (9 arquivos relacionados). Typecheck/Build: não
necessários (sem alteração). Git status registrado. **Nenhum código de produção alterado;
nenhuma recomendação implementada; nenhuma FASE 06 iniciada.**


