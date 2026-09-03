# FASE 06.3 â€” ENGENHARIA REVERSA DOS MODELOS DE PLANEJAMENTO

> **Data:** 2026-09-09 Â· **Tipo:** inspeÃ§Ã£o â†’ engenharia reversa â†’ comparaÃ§Ã£o â†’ extraÃ§Ã£o de conceitos â†’ decisÃ£o arquitetural (read-only)
> **Status:** CONCLUÃDA â€” nenhum cÃ³digo do OpenWork foi alterado/criado alÃ©m desta documentaÃ§Ã£o.
> **Regra da fase respeitada:** EAP existente (81 nÃ³s) NÃƒO recriada; NADA implementado (sem Service, Activity, Scheduler, CPM, Gantt, LOB, Agent, Skill, MCP, banco, rotas ou sidebar).

---

## 1. Objetivo

Estudar os repositÃ³rios de referÃªncia disponÃ­veis localmente e produzir uma anÃ¡lise tÃ©cnica
fundamentada em cÃ³digo (nÃ£o em READMEs) para decidir **como construir o motor de planejamento
do OpenWork** sobre um Ãºnico modelo operacional, sem copiar cÃ³digo de terceiros e sem criar
mÃºltiplas fontes de verdade.

## 2. Escopo

- InspeÃ§Ã£o read-only de 6 referÃªncias locais + contexto interno do OpenWork (EAP existente).
- Mapeamento de: modelo de dados, hierarquia Ã— precedÃªncia, relaÃ§Ãµes (FS/SS/FF/SF/lag),
  calendÃ¡rio, scheduling engine, CPM, quantidade/produtividade, baseline/actual, Gantt, LOB,
  recursos, produÃ§Ã£o e testes.
- Entrega: este documento + documento de produto (`docs/features/...`, ver Â§24).

## 3. RepositÃ³rios encontrados

| # | Projeto | Caminho local | Branch/commit | Linguagem/Framework | LicenÃ§a | Papel nesta anÃ¡lise |
|---|---------|---------------|---------------|---------------------|---------|---------------------|
| 1 | **OpenProject** | `C:\Users\Correta Engenharia\Desktop\OPENWORK-LAB\openproject` | `dev` Â· `e39f977b2d0` (2026-09-02) Â· v17.9.0 | Ruby on Rails + Angular (frontend) | GPLv3 | ReferÃªncia principal de Work Package/relaÃ§Ãµes/scheduling |
| 2 | **construction-gantt** | `C:\Users\Correta Engenharia\Desktop\Nova pasta (2)\construction-gantt-main` | sem `.git` (snapshot) | TypeScript (pnpm monorepo, vitest) | MIT | Motor CPM + calendÃ¡rio + baseline + MSPDI |
| 3 | **OpenConstructionERP** | `C:\Users\Correta Engenharia\Desktop\Nova pasta (2)\OpenConstructionERP-main` | sem `.git` (snapshot) Â· v16.5.0 | Python (FastAPI/SQLAlchemy/PostgreSQL) + React/TS/Vite | AGPL-3.0 | ERP de construÃ§Ã£o: QÃ·Produtividade, CPM, leveling, progresso, BOQ |
| 4 | **GanttReady (NetPlan)** | `C:\Users\Correta Engenharia\Desktop\Nova pasta (2)\GanttReady-main` | sem `.git` (snapshot) | C# .NET 8 Blazor + SQLite (xUnit) | MIT | Gantt + CPM + calendÃ¡rio por projeto + baseline + EV |
| 5 | **ProjectLibre** | `C:\Users\Correta Engenharia\Desktop\Nova pasta (2)\projectlibre-master` | sem `.git` (snapshot) Â· fork do OpenProj | Java (Swing) | CPAL 1.0 / CPL 1.0 (OpenProj) | Compatibilidade conceitual MS Project (CPM, sentinelas, snapshots) |
| 6 | **ARES** | `C:\Users\Correta Engenharia\Desktop\obracopilot_excel` | sem Git (congelado 31/08/2026) | Excel nativo (18 abas, `tb*`) + Python FastAPI | **Interno/proprietÃ¡rio** (nÃ£o Ã© open source) | ReferÃªncia interna: serviÃ§o â†’ frente â†’ equipe â†’ produÃ§Ã£o; rede de precedÃªncias; LOB derivada |
| â€” | **gantts-app** | **NÃƒO encontrado** | â€” | â€” | â€” | Ausente localmente â†’ fora da matriz |
| â€” | **OpenProject (clone `openproject-dev`)** | `C:\Users\Correta Engenharia\Desktop\openproject-dev` | sem `.git` (snapshot, mesmo conteÃºdo) | Ruby on Rails | GPLv3 | Usado como confirmaÃ§Ã£o de versÃ£o 17.9.0 |

> Registro: nenhum clone/download/instalaÃ§Ã£o foi feito; todos os repositÃ³rios jÃ¡ estavam locais.
> O `OPENWORK-LAB/openproject` tem Git real (commit `e39f977b2d0`); os demais sÃ£o snapshots de trabalho (sem `.git`),
> portanto **commits exatos nÃ£o disponÃ­veis** â€” registrado o que existia.

## 4. VersÃµes / commits

- **OpenProject:** branch `dev`, HEAD `e39f977b2d0` (`[COMMS-974] Support observed_in_versions in bulk WP edit`), versÃ£o declarada `17.9.0`.
- **construction-gantt:** monorepo privado `construction-gantt-monorepo`, pnpm 11.1.2, Node â‰¥ 22 (sem tag no snapshot).
- **GanttReady:** `.NET 8`, solution `NetPlan.slnx`, migraÃ§Ãµes EF de 2026-05-06 a 2026-06-01.
- **OpenConstructionERP:** `16.5.0` (pyproject + package.json frontend).
- **ProjectLibre:** snapshots de arquivo; headers CPAL 2006-2007 (OpenProj origin).
- **ARES:** congelado â€” hash SHA-256 `95f1e23aâ€¦` da planilha oficial em 28/08/2026; LOB aprovada em WORK final (19 abas).

## 5. LicenÃ§as e uso como referÃªncia

| Projeto | LicenÃ§a | Copiar cÃ³digo? | Copiar estrutura? | RecomendaÃ§Ã£o |
|---------|---------|----------------|-------------------|--------------|
| OpenProject | GPLv3 | âŒ (contaminaria produto prÃ³prio; frontend Angular incompatÃ­vel) | âœ… conceitos (models/scheduler) | Estudar e reimplementar |
| construction-gantt | MIT | âš ï¸ possÃ­vel legalmente, mas **proibido pela polÃ­tica da fase** | âœ… | Estudar e reimplementar |
| OpenConstructionERP | AGPL-3.0 | âŒ (rede; forte contaminaÃ§Ã£o) | âœ… conceitos de domÃ­nio | Estudar e reimplementar |
| GanttReady | MIT | âš ï¸ idem | âœ… | Estudar e reimplementar |
| ProjectLibre | CPAL/CPL | âŒ (atribuiÃ§Ã£o obrigatÃ³ria + logo) | âœ… conceitos | Estudar e reimplementar |
| ARES | Interno/autoral | âŒ (Ã© nosso, mas a fase Ã© de estudo) | âœ… regras de negÃ³cio como conceito | Absorver regras (QÃ·P, frentes, equipes) |

**DecisÃ£o:** nenhuma linha de cÃ³digo dos repositÃ³rios deve ser copiada no OpenWork. O objetivo Ã©
ESTUDAR â†’ ENTENDER â†’ EXTRAIR CONCEITOS â†’ REIMPLEMENTAR com arquitetura prÃ³pria.

---
## 6. Arquitetura de cada referÃªncia (como o software realmente funciona)

### 6.1 OpenProject â€” Work Package como entidade Ãºnica

```
WorkPackage (tabela work_packages)
  â”œâ”€â”€ hierarchy: parent_id + closure table work_package_hierarchies (ancestor_id, descendant_id, generations)
  â”œâ”€â”€ relations: entidade Relation (from_id, to_id, relation_type, lag)
  â”œâ”€â”€ schedule: SetScheduleService (forward only) â†’ reescreve start_date/due_date/duration
  â”œâ”€â”€ working days: global (Setting.working_days + NonWorkingDay) OU per-WP ignore_non_working_days
  â””â”€â”€ Gantt: frontend LE as datas da API (startDate/dueDate) â€” nÃ£o persiste nada
```

EvidÃªncias:
- `app/models/work_package.rb`: `belongs_to :project/status/type/assigned_to/responsible`;
  `include WorkPackage::SchedulingRules`, `WorkPackages::DerivedDates`, `WorkPackages::Relations`;
  campos `duration`, `done_ratio`, `estimated_hours`, `remaining_hours`, `schedule_manually`,
  `ignore_non_working_days`, `start_date`, `due_date`, `parent_id`.
- `app/services/work_packages/update_service.rb` â†’ `reschedule_related` â†’
  `WorkPackages::SetScheduleService` (chamada quando `start_date`, `due_date`, `parent`,
  `schedule_manually` mudam).
- **A fonte da verdade sÃ£o as datas persistidas no WorkPackage**; o scheduler as recalcula e grava de
  volta (`set_dates` grava `work_package.duration = days.duration(start, due)`).

### 6.2 construction-gantt â€” motor de schedule puro e imutÃ¡vel

```
Project { start, end?, defaultCalendarId, tasks, links, resources, calendars, baselines, assignments }
  schedule(project) â†’ Project (nÃ£o muta entrada)
    1. topologicalSort (Kahn) sobre links (lanÃ§a se ciclo)
    2. forward pass (ES/EF) + constraints ASAP/ALAP/MSO/MFO/SNET/FNET
    3. backward pass (LS/LF) + constraints MSO/MFO/SNLT/FNLT
    4. totalSlack/freeSlack/isCritical (negativo preservado, nÃ£o clipado)
    5. datas das tarefas auto sÃ£o REESCRITAS em task.start/end; summary sempre derivadas dos filhos
```

EvidÃªncias: `packages/core/src/schedule.ts`, `topological-sort.ts`, `types.ts`, `analysis.ts`,
`baseline.ts`, `working-time.ts`, `src/mspdi/` (compatibilidade MSPDI MS Project).

### 6.3 OpenConstructionERP â€” CPM no backend + duraÃ§Ã£o derivada de quantidade

```
Schedule â†’ Activity (parent_id, wbs_code, â€¦) + ScheduleRelationship (predecessor/successor/type/lag_days)
  â”œâ”€â”€ core/cpm.py            â†’ CPM puro e stateless em dicts (forward/backward/float), calendar-aware
  â”œâ”€â”€ schedule_advanced/cpm.py â†’ TaskNetwork/Activity/CPMResult (compute_cpm, critical_path,
  â”‚                              driving_chain, multiple_float_paths, out-of-sequence CPM, QA)
  â”œâ”€â”€ leveling.py + resources/resource_engine â†’ resource leveling (serial-greedy; todos os 4 tipos)
  â”œâ”€â”€ schedule/service.py    â†’ _calc_duration_from_resources (QÂ·labor_hours Ã· crewÂ·hpd â†’ dias)
  â”œâ”€â”€ schedule/progress_math.py â†’ % fÃ­sico vs duraÃ§Ã£o vs unidades; EVM; suspend/resume
  â””â”€â”€ Gantt: endpoint get_gantt_data â†’ GanttActivity (id, start, end, duration, progress, dependencies)
```

EvidÃªncias: `backend/app/modules/schedule/{models,service,progress_math,ordering,schemas}.py`,
`backend/app/modules/schedule_advanced/{cpm,leveling,delay_engine,delay_service}.py`,
`backend/app/core/{cpm,calendar}.py`.

### 6.4 GanttReady (NetPlan) â€” CPM persistido + calendÃ¡rio por projeto

```
Project (WorkDayBits, WorkingHoursPerDay, WorkdaysPerWeek) â†’ TaskItem â†’ TaskRelation (FS/SS/SF/FF + Lag)
  ScheduleEngine.Calculate â†’ grava ES/EF/LS/LF/TF/FF/IsCritical (INT offset dias) NOS TaskItems (banco)
  CalendarService â†’ AddWorkingDays(projectId, start, duration) â€” pula feriados do projeto
  AnalysisService â†’ progress, EV, schedule variance, resource loading, stage completion
```

EvidÃªncias: `src/GanttReady.Server/{Models, Services/ScheduleEngine.cs, Services/CalendarService.cs}`.
**AtenÃ§Ã£o:** o GanttReady PERSISTE os resultados CPM no banco (diferente do construction-gantt,
que deriva em memÃ³ria). Campo `ExtraData` em `TaskItem` guarda flags de delay/estado.

### 6.5 ProjectLibre â€” algoritmo CPM com sentinelas Start/End

```
Project â†’ CriticalPath implements SchedulingAlgorithm
  startSentinel (<Start>, dur 0) e finishSentinel (<End>) conectam nÃ³s sem pred/succ
  forward/backward via PredecessorTaskTree + TaskSchedule (CURRENT/EARLY/LATE)
  DependencyType: FS=1 (default), SS=3, FF=0, SF=2; lag em minutos via WorkCalendar
  snapshot/DataSnapshot + BaselineScheduleFields (getBaselineStart(numBaseline)â€¦) â†’ mÃºltiplos baselines
```

EvidÃªncias: `openproj_core/src/com/projity/pm/criticalpath/{CriticalPath,SchedulingAlgorithm,ScheduleWindow,TaskSchedule}.java`,
`dependency/DependencyType.java`, `scheduling/SchedulingRule.java` (FixedUnits/FixedWork/FixedDuration),
`snapshot/BaselineScheduleFields.java`.

### 6.6 ARES â€” planilha como fonte + regras de rede + LOB derivada

```
Excel (tbPlanejamento=datas/status/%real Â· tbPlanejamentoLegado Â· tbRede=18 elos Â· tbServicos Â· tbEAP Â·
       tbFrentes Â· tbEquipes Â· tbProducao Â· tbMedicao Â· tbRecursos)
  â”œâ”€â”€ gerar_rede_precedencias.py â†’ R1 (precedente explÃ­cito), R6 (mesma equipe), FS+lag(dias),
  â”‚                                 substituiÃ§Ã£o formal no replanejamento, detecÃ§Ã£o de ciclo (DFS)
  â””â”€â”€ LOB (construir_aba_lob_v5) â†’ VISTA DERIVADA com 0 dados independentes (fÃ³rmulas sobre o legado/CADASTRO)
```

EvidÃªncias: `ARES_REDE_precedencias.csv`, `docs/ARCHITECTURE_CURRENT_STATE.md`,
`obracopilot-addin/backend/gerar_rede_precedencias.py` e `construir_aba_lob_v5.py`.

---
## 7. Modelo de dados â€” o que cada um persiste

### 7.1 OpenProject (tabelas, inferidas de models + API representers)
- `work_packages`: `id, subject, description, project_id, type_id, status_id, priority_id, author_id,
  assigned_to_id, responsible_id, parent_id, start_date, due_date, duration, done_ratio,
  estimated_hours, remaining_hours, schedule_manually, ignore_non_working_days, lock_version`
  (+ journals/histÃ³rico de versÃ£o).
- `relations`: `from_id, to_id, relation_type, lag, description`; unique `(from, to)`; lag Â±2000.
- `work_package_hierarchies` (closure tree): `ancestor_id, descendant_id, generations`.
- `non_working_days` (global): `date, name` Â· dias Ãºteis da semana: `Setting.working_days` (ISO 1â€“7).
- `status` (workflow) Â· `types` (incl. `is_milestone`) Â· `ordered_work_packages`.

### 7.2 construction-gantt (tipos TS, em memÃ³ria)
- `Task { id, text, parent?, type: task|summary|milestone, scheduleMode: auto|manual, duration
  (min trabalhado), start, end, progress, constraint?, resourceIds?, calendarId?, computed? }`
- `Link { id, source, target, type: FS|SS|FF|SF, lag (min trabalhado) }`
- `Calendar { id, name, workWeek: WorkInterval[][], exceptions[], baseCalendarId? }`
- `Resource` Â· `Assignment { units }` Â· `Baseline { index 0..10, tasks: Map<snapshot> }` Â· `Project`.

### 7.3 OpenConstructionERP (tabelas `oe_schedule_*`)
- `Activity`: `schedule_id, parent_id, wbs_code, start_date, end_date, duration_days, progress_pct,
  status, activity_type, dependencies (JSON), resources (JSON), boq_position_ids (JSON),
  early_start/finish, late_start/finish, total_float, free_float, is_critical, constraint_type/date,
  activity_code, bim_element_ids, cost_planned/actual, percent_complete_type, remaining_duration,
  budgeted_units, installed_units, calendar_id, revisionâ€¦`
- `ScheduleRelationship`: `schedule_id, predecessor_id, successor_id, relationship_type (FS/FF/SS/SF),
  lag_days, metadata` â€” unique `(predecessor, successor)`.
- `WorkOrder`: `activity_id, assembly_id, boq_position_id, code, assigned_to, planned/actual start/end,
  planned_cost, actual_cost, status` â€” **ordem de serviÃ§o/execuÃ§Ã£o no campo**.
- `Schedule`: `project_id, schedule_type, start/end, status (draftâ€¦), data_date`.

### 7.4 GanttReady (EF Core/SQLite)
- `TaskItem`: `Code, Name, ParentTaskId, OutlineLevel, PlanStartDate, PlanEndDate, PlanDuration,
  ActualStartDate, ActualEndDate, ActualDuration, CompletionPercentage, BudgetCost, ActualCost,
  IsMilestone, IsManualSchedule, EarlyStart/Finish, LateStart/Finish, TotalFloat, FreeFloat,
  IsCritical (persistidos!), ExtraData (JSON), ResponsiblePerson`.
- `TaskRelation`: `PredecessorTaskId, SuccessorTaskId, Type (enum FS/SS/SF/FF), Lag (dias, negativo ok)`.
- `Project`: `PlanStartDate/End, ActualStartDate/End, WorkingHoursPerDay=8, WorkdaysPerWeek=5,
  WorkDayBits=0b00111110` Â· `ProjectHoliday` Â· `Baseline (Number 1..5, Name)` + `BaselineTask`.
- `Resource`: compartilhado (ProjectId null) ou por projeto; `Unit, Quantity, UnitPrice, HourlyCost, Type`.

### 7.5 ProjectLibre (Java)
- `Task`/`NormalTask`: start/finish, duration, percent complete, constraint type/date, schedules
  (`TaskSchedule` CURRENT/EARLY/LATE), baselines `getBaselineStart(numBaseline)â€¦`.
- `Dependency`: tipo (FS/SS/FF/SF) + defasagem (via calendÃ¡rio de trabalho, minutos).
- `Assignment`/`Allocation`: units/duration/work com `SchedulingRule` (FixedUnits/FixedWork/FixedDuration).
- `Project`/`Resourcing`/`Costing`: EVM e custos calculados a partir de allocations.

### 7.6 ARES (planilha)
- `tbPlanejamento` (novo, 21â€“31 atividades ativas `PLAN-*` com EQUIPE, INÃCIO, FIM, PREDECESSORA_ID,
  STATUS) + `tbPlanejamentoLegado` (15 atividades reais com INÃCIO/FIM/STATUS/%REAL);
- `tbRede` (18 elos: `ID ELO; PREDECESSORA; SUCESSORA; TIPO DE RELAÃ‡ÃƒO; DEFASAGEM; ORIGEM DA REGRA; LÃ“GICA`);
- `tbServicos` (`SERVICO-*` â†’ EAP, FRENTE, LOCAL, UNIDADE) Â· `tbEAP` (WBS, nome, tipo, pai, nÃ­vel) Â·
  `tbFrentes`/`tbEquipes` Â· `tbProducao`/`tbMedicao` Â· `tbRecursos`/`tbEquipeRecursos`/`tbServicoRecursos`.

---
## 8. Hierarquia (resp. Ã s questÃµes 4.1â€“4.5)

### 4.1 A hierarquia Ã© a mesma coisa que dependÃªncia?
**NÃƒO â€” em todos os 6 sistemas.** Mecanismos separados:
- OpenProject: hierarquia = `parent_id` + closure `work_package_hierarchies`; dependÃªncia = `Relation`.
  O comentÃ¡rio em `relation.rb` Ã© explÃ­cito: *"The parent/child relation is maintained separately (in
  WorkPackage and WorkPackageHierarchy) and a relation cannot have the type 'parent'"*.
- construction-gantt: `parent` (Task) vs `Link`; `topological-sort.ts` afirma que a hierarquia **nÃ£o**
  participa da ordenaÃ§Ã£o â€” sÃ³ `links`.
- OpenConstructionERP: `Activity.parent_id` vs `ScheduleRelationship`.
- GanttReady: `ParentTaskId`/`OutlineLevel` vs `TaskRelation`.
- ProjectLibre: `ForParent/ForAllChildren` vs `Dependency`; CPM usa sentinelas sobre dependÃªncias.
- ARES: `tbEAP` (pai/nÃ­vel) e `tbRede` (elos) sÃ£o tabelas distintas; as regras R3/R4/R5 (hierarquia de
  pavimentos) foram **desativadas** justamente para nÃ£o confundir estrutura com precedÃªncia.

### 4.2 Um item pode ter pai, filhos, predecessores e sucessores simultaneamente?
**SIM â€” em todos:**
- OpenProject: `parent_id` (1 pai), mÃºltiplos filhos (closure), `follows_relations` (pred) e
  `precedes_relations` (succ) â€” `app/models/work_packages/relations.rb`.
- construction-gantt: `Task.parent` + `Link.source/target` sem exclusividade mÃºtua.
- Demais sistemas: idem (campos `parent_id` + tabelas de relaÃ§Ã£o separadas).
- Ressalva real: no **scheduler**, o grafo de datas usa apenas relaÃ§Ãµes `follows`/`links`; a hierarquia
  entra depois para **derivar datas de resumo** (summary aggregation), nÃ£o para precedÃªncia.

### 4.3 Como separar HIERARQUIA de RELAÃ‡ÃƒO DE PRECEDÃŠNCIA?
- RepresentaÃ§Ãµes separadas em todos (FK `parent_id`/closure/`parent` vs `Relation`/`Link`/`Relationship`).
- OpenProject `used_for_scheduling_of`: relaÃ§Ã£o de ancestral **automÃ¡tico** vale para o descendente;
  pai **manual corta a corrente**. Hierarquia nunca vira precedÃªncia; define agregados e datas derivadas.
- construction-gantt (`schedule.ts`): summary = `min(child earlyStart)` / `max(child earlyFinish)` â€”
  agrega, nunca ordena.

### 4.4 Um item da EAP Ã© necessariamente uma atividade de planejamento?
**NÃƒO.**
- No OpenWork, `ObraEapNode { obraId, wbs, nome, nivel, tipo (DISCIPLINA|PACOTE|TRABALHO), pai, ordem,
  fundamentacao, condicao }` â€” **sem datas/duraÃ§Ã£o/relaÃ§Ãµes/progresso**.
- A prÃ³pria referÃªncia interna adota o princÃ­pio **"separacao_eap_do_cronograma"** (WBS â‰  cronograma).
- Nos sistemas de referÃªncia, o nÃ³ estrutural (summary/work package/outline) sÃ³ agrega; nunca Ã© o nÃ³
  agendÃ¡vel por si (milestone Ã© um tipo de tarefa, nÃ£o um nÃ³ de EAP).
- A EAP garante o **WBS de rastreabilidade** (`wbs_code`/`OutlineNumber`/`WBS` MSPDI), nÃ£o o cronograma.

### 4.5 MELHOR SEPARAÃ‡ÃƒO CONCEITUAL PARA O OPENWORK (recomendada â€” ver Â§20)
```
EAP (estrutura, sem tempo) â†’ ServiÃ§o (escopo executÃ¡vel, qtd/unidade) â†’ Atividade (nÃ³ agendÃ¡vel)
RelaÃ§Ãµes (FS/SS/FF/SF+lag) entre Atividades â†’ CalendÃ¡rio por obra (dias Ãºteis) â†’ Scheduling (derivado)
```
Hierarquia restrita a: (a) EAP (estrutural) e (b) Atividadeâ†’subatividade (agregaÃ§Ã£o p/ resumo);
precedÃªncia fica **exclusivamente** nas RelaÃ§Ãµes. Datas armazenadas = saÃ­da do scheduler.

---
## 9. RelaÃ§Ãµes (com exemplos concretos no cÃ³digo)

### 9.1 RepresentaÃ§Ãµes encontradas
| Sistema | Entidade | Tipos | Lag | ValidaÃ§Ã£o |
|---------|----------|-------|-----|-----------|
| OpenProject | `Relation` | `precedes/follows` (scheduling) + `relates, blocks, duplicated, partof, requires` | `lag` int Â±2000 (**dias Ãºteis** entre pred-fim e succ-inÃ­cio) | unique `(to,from)`; `reverse_if_needed` |
| construction-gantt | `Link` | `FS/SS/FF/SF` | `lag` **min trab.** (pos=delay, neg=lead) | topo sort lanÃ§a em ciclo |
| OpenConstructionERP | `ScheduleRelationship` | `FS/FF/SS/SF` | `lag_days` int (neg=lead) | unique `(pred,succ)` |
| GanttReady | `TaskRelation` | enum `FS/SS/SF/FF` | `Lag` int dias (neg ok) | â€” |
| ProjectLibre | `Dependency` | `FS=1 (default), SS=3, FF=0, SF=2` | defasagem via calendÃ¡rio (min) | â€” |
| ARES | `tbRede` | FS (Ãºnico usado) | `DEFASAGEM` dias | R10 ciclo (DFS) |

### 9.2 DireÃ§Ã£o da relaÃ§Ã£o
- OpenProject usa convenÃ§Ã£o invertida: `from`=sucessor, `to`=predecessor
  (`def predecessor = to; def successor = from`) e forÃ§a a forma canÃ´nica `follows`.
- Demais sistemas: natural `predecessor â†’ successor` (sourceâ†’target).
- **RecomendaÃ§Ã£o OpenWork:** `predecessor_id â†’ successor_id` (natural, maioria), com tipo gravado
  sempre na forma canÃ´nica (gravar "FS"; derivar o espelho ao exibir).

### 9.3 FÃ³rmulas reais (forward/backward) â€” evidÃªncia `schedule_advanced/cpm.py` e `ScheduleEngine.cs`
```
Forward (ES do sucessor s, com predecessor p e duraÃ§Ã£o d de s):
  FS: s.ES >= p.EF + lag
  SS: s.ES >= p.ES + lag
  FF: s.EF >= p.EF + lag  â†’ ES-bound: s.ES >= p.EF + lag - d
  SF: s.EF >= p.ES + lag  â†’ ES-bound: s.ES >= p.ES + lag - d
Backward (LF do predecessor p, com sucessor s e duraÃ§Ã£o d de p):
  FS: p.LF = s.LS - lag
  SS: p.LF = s.LS - lag + d
  FF: p.LF = s.LF - lag
  SF: p.LF = s.LF - lag + d
Float: TF = LS - ES (= LF - EF); FF = min(ajustes dos sucessores); isCritical = TF <= 0.
```

### 9.4 Ciclos / mÃºltiplas relaÃ§Ãµes / hierarquiaÃ—dependÃªncia
- Ciclos: GanttReady lanÃ§a `InvalidOperationException` listando os nÃ³s; OpenConstructionERP `CycleError`;
  construction-gantt `topologicalSort` lanÃ§a; OpenProject `DependencyGraph` Ã© iterativo (regressÃ£o
  #43894 de stack overflow); ARES R10 com DFS.
- MÃºltiplas relaÃ§Ãµes: permitidas em todos; unique por par Ã© o guarda (OpenProject/OpenConstructionERP).
- HierarquiaÃ—dependÃªncia: independentes (Â§8). OpenProject propaga relaÃ§Ãµes de ancestrais automÃ¡ticos
  para descendentes (`used_for_scheduling_of`) e o pai manual corta a cadeia.
- Casos cobertos em testes: diamond convergence, mÃºltiplos caminhos, SS ties, lag +/-, milestone FF.

---
## 10. CalendÃ¡rio

### 10.1 Como cada sistema representa
| Sistema | Entidade/arquivo | Granularidade | Semana | Feriados/exceÃ§Ãµes | Por projeto | Por recurso | Por tarefa |
|---------|------------------|---------------|--------|-------------------|-------------|-------------|------------|
| OpenProject | `WeekDay`, `NonWorkingDay`, `Shared::WorkingDays` | **dia** (sem horas) | `WeekDay(day 1..7, working bool)` global | `NonWorkingDay(date)` global | âŒ (global Ã  instÃ¢ncia) | âŒ | parcial: `ignore_non_working_days` por WP |
| construction-gantt | `Calendar { workWeek: WorkInterval[][], exceptions[], baseCalendarId }` | **minuto** (turnos parciais) | 7 arrays de `WorkInterval{startMinute,endMinute}` | `CalendarException{date,isWorking,intervals,name}` | `project.defaultCalendarId` | `Resource.calendarId` | `Task.calendarId` |
| GanttReady | `CalendarService`, `Project.WorkOnSaturday/Sunday`, `ProjectHoliday` | **dia** (offset inteiro) | flags de sÃ¡b/dom no projeto | `ProjectHoliday(Date, Name)` por projeto | âœ… | âŒ | âŒ |
| OpenConstructionERP | `core/calendar.py` (paÃ­s) + `WORK_CALENDARS` (regiÃ£o) | **dia** + `hours_per_day` | `work_days: {0..4}` ou `{0..5}` | `resolve_holidays(country, year)` com proveniÃªncia (Easter, Hijri, equinÃ³cios) | por `project.region` (sÃ³ na geraÃ§Ã£o via BOQ) | âŒ | âŒ |
| ProjectLibre | `WorkingCalendar`, `WorkWeek`, `WorkDay`, `WorkingHours`, `CalendarCatalog` | **milissegundo/turno** | `WorkWeek` + `DayDescriptor` | `CalendarException` via `CalendarDefinition.differences` | âœ… (`HasCalendar`) | âœ… (`HasBaseCalendar`, heranÃ§a baseâ†’derivado) | âœ… |
| ARES | `CADASTRO!B13/B14` + datas manuais | dia | â€” (implÃ­cito) | â€” | âœ… (datas da obra) | âŒ | âŒ |

### 10.2 `data + duraÃ§Ã£o` e `data âˆ’ duraÃ§Ã£o` sobre dias nÃ£o Ãºteis

**OpenProject** (`WorkPackages::Shared::WorkingDays`): `add_days(date, count)` avanÃ§a dia a dia pulando
nÃ£o Ãºteis; `soonest_working_day(date)` empurra para frente; `duration(start, due)` conta dias Ãºteis
**inclusivos** nas duas pontas. `start_date`/`due_date` sÃ£o datas inclusivas (`duration=1` â‡’ start==due).
NÃ£o hÃ¡ hora nem timezone no cÃ¡lculo. Existe `Shared::Days` (modo "todos os dias"), escolhido por
`ignore_non_working_days` por WP â€” **o modo de calendÃ¡rio Ã© atributo da tarefa**.

**construction-gantt** (`working-time.ts`): 7 funÃ§Ãµes puras â€” `isWorkingDay`, `getDayWorkingMinutes`,
`addWorkingMinutes`, `subtractWorkingMinutes`, `snapToNextWorkingMoment`,
`snapToPreviousWorkingMoment`, `workingMinutesBetween`. DuraÃ§Ã£o Ã© **minutos de trabalho**;
`fim = addWorkingMinutes(inÃ­cio, duration, calendar)` consome turnos parciais e pula noites/fins de
semana/exceÃ§Ãµes. `snapTo*` resolve data em momento nÃ£o Ãºtil.

**GanttReady** (`ScheduleEngine` + `CalendarService`): o motor trabalha em **offsets inteiros de dias
Ãºteis** (`EarlyStart=0` no dia zero) e sÃ³ no fim converte offsetâ†’data real via `CalendarService`
(pula sÃ¡b/dom/feriados). **CPM em espaÃ§o adimensional, calendÃ¡rio aplicado sÃ³ na materializaÃ§Ã£o.**

**OpenConstructionERP**: `_working_days_between` Ã© **exclusivo do inÃ­cio, inclusivo do fim**
(convenÃ§Ã£o documentada, replicada em `progress_math.WorkCalendar.working_days_between` para que
progresso e CPM concordem). Feriados vÃªm de `core/calendar.py` com proveniÃªncia
(`declared`/`fell_back`/`unavailable`).

**ProjectLibre**: `WorkingCalendar.add(date, duration, useSooner)` e `compare(later, earlier, elapsed)`
delegam ao `CalendarDefinition` concreto (base+diferenÃ§as). Milissegundos de trabalho; suporta
`elapsed` (duraÃ§Ã£o corrida, ignora calendÃ¡rio).

### 10.3 Achados crÃ­ticos para o OpenWork
1. **Inclusividade Ã© decisÃ£o que precisa ser Ãºnica.** OpenProject conta duas pontas inclusivas;
   OpenConstructionERP Ã© exclusivo-inÃ­cio/inclusivo-fim. Misturar gera erro de Â±1 dia sistemÃ¡tico.
2. **Dia Ã— minuto.** OpenProject e GanttReady sÃ£o "dia inteiro" (sem timezone) â€” simples e suficiente
## 11. Scheduling Engine

### 11.1 Pipeline observado em cada motor

**OpenProject** â€” `WorkPackages::SetScheduleService` (nÃ£o Ã© CPM):
```
INPUT: WP alterado (dates/parent/relations)
  â†“ ScheduleDependency (monta grafo: sucessores + ancestrais + descendentes)
  â†“ DependencyGraph (iterativo p/ evitar stack overflow â€” #43894)
  â†“ para cada dependente "automatic": reschedule!
  â†“   soonest_start = max(predecessor.due_date + lag) via Relations::UsedForSchedulingOf
  â†“   WorkingDays.add_days / soonest_working_day
  â†“ pais automÃ¡ticos: derived_start/due = min/max dos filhos (DerivedDates)
OUTPUT: novas start_date/due_date persistidas no WP
```
Motor **incremental/reativo de forward-only**: empurra sucessores para frente, **nunca puxa para
trÃ¡s**, **nÃ£o calcula LS/LF/float**, **nÃ£o hÃ¡ caminho crÃ­tico**. `schedule_manually=true` congela o
WP e **corta a propagaÃ§Ã£o** naquele ramo (`for_scheduling` scope).

**construction-gantt** â€” `schedule(project): Project` (CPM completo, funÃ§Ã£o pura):
```
topologicalSort(tasks, links)                 â†’ lanÃ§a em ciclo
  â†“ Forward pass (folhas): ES = max(bound de cada link) âˆ¨ projectFloor
  â†“   applyForwardConstraint (ASAP/MSO/MFO/SNET/FNET)
  â†“ Summaries bottom-up: ES=min(filhos), EF=max(filhos) [aggregateFromChildren]
  â†“ Backward pass: LF/LS + applyBackwardConstraint (MSO/MFO/SNLT/FNLT)
  â†“ Summaries bottom-up backward [aggregateBackwardFromChildren]
  â†“ totalSlack = workingMinutesBetween(ES, LS); freeSlack = computeFreeSlack(...)
  â†“ isCritical = totalSlack <= 0     [ADR-003: NÃƒO clipa slack negativo]
OUTPUT: task.computed (ES/EF/LS/LF/slack) + start/end reescritos p/ tarefas 'auto'
```
`scheduleMode:'manual'` â†’ datas do usuÃ¡rio autoritativas; motor **ainda assim** popula `forwardById`
para o backward pass calcular folga contra a rede. FunÃ§Ã£o **pura** (`Projectâ†’Project`), sem I/O/ORM.

**GanttReady** â€” `ScheduleEngine.Calculate(tasks, relations, startDate) -> int projectDuration`:
```
ordenaÃ§Ã£o topolÃ³gica (exceÃ§Ã£o se ciclo, listando nÃ³s)
  â†“ CalculateEarlyTimes (ES/EF em offsets de dias, 4 tipos + lag, respeita IsManualSchedule)
  â†“ projectDuration = max(EF)
  â†“ CalculateLateTimes (LS/LF; sink â†’ LF = projectDuration)
  â†“ CalculateFloat (TotalFloat = LSâˆ’ES; FreeFloat via sucessores)
  â†“ IsCritical
  â†“ CalendarService: offset â†’ data real (pula sÃ¡b/dom/feriados)
```

**OpenConstructionERP** â€” dois motores separados:
- `modules/schedule/service.py`: CRUD + Gantt + duraÃ§Ã£o a partir de BOQ; **persiste** `start_date`/`end_date`.
- `modules/schedule_advanced/cpm.py`: CPM real e derivado, com refinamentos que os outros nÃ£o tÃªm â€”
  **union-find de componentes fracamente conexos** (cada "ilha" ancora seu prÃ³prio `project_finish`,
  evitando sink global falso), `driving_predecessor`/`driving_chain`/`longest_path` (caminho
  **dirigente** por forward pass, correto mesmo quando calendÃ¡rios/constraints fazem o conjunto por
  float discordar), desempate determinÃ­stico por `(topo_rank, str(id))`.

## 12. CPM

### 12.1 Onde o CPM vive em cada sistema
| Sistema | CPM Ã©â€¦ | Persistido? | EvidÃªncia |
|---------|--------|-------------|-----------|
| OpenProject | **inexistente** | â€” | nÃ£o hÃ¡ LS/LF/float em `work_package.rb` nem em serviÃ§os |
| construction-gantt | **parte do scheduler** (`schedule.ts`) | nÃ£o (em `task.computed`, memÃ³ria) | `TaskComputed{earlyStart,earlyFinish,lateStart,lateFinish,totalSlack,freeSlack}` |
| GanttReady | **parte do scheduler** (`ScheduleEngine`) | **sim** (campos em `TaskItem`) | `EarlyStart/EarlyFinish/LateStart/LateFinish/TotalFloat/IsCritical` |
| OpenConstructionERP | **mÃ³dulo separado derivado** (`schedule_advanced/cpm.py`) | nÃ£o (calculado sob demanda) | `CPMResult`, `longest_path`, `portfolio_cpm.py` |
| ProjectLibre | **parte do modelo vivo** (`CriticalPath` + `TaskSchedule`) | sim, em memÃ³ria no documento | `pm/criticalpath/*` |
| ARES | **nÃ£o existe** (rede sem CPM) | â€” | `tbRede` sÃ³ armazena elos; `gerar_rede_precedencias.py` sÃ³ detecta ciclo |

### 12.2 FÃ³rmulas de float encontradas
```
TotalFloat = LS âˆ’ ES  (= LF âˆ’ EF)        [GanttReady, cpm.py, construction-gantt]
FreeFloat  = min sobre sucessores do "quanto posso atrasar sem empurrar o ES do sucessor"
             â€” em cpm.py e computeFreeSlack() calculado por tipo de link (FS/SS/FF/SF)
             â€” para sink: folga atÃ© o finish do prÃ³prio componente
isCritical = TotalFloat <= 0             [<= 0, nÃ£o == 0, para capturar float negativo]
```
- **construction-gantt ADR-003:** float negativo Ã© **preservado, nunca zerado** â€” sinal de cronograma
  inviÃ¡vel contra restriÃ§Ã£o a jusante. **Conceito a adotar.**
- **OpenConstructionERP `longest_path`:** o caminho crÃ­tico "por float" pode ser enganoso com
  calendÃ¡rios/constraints mÃºltiplos; o **Longest Path** derivado do forward pass Ã© mais confiÃ¡vel.
  **Conceito a adotar.**

### 12.3 Casos de borda tratados
| Caso | Quem trata | Como |
|------|-----------|------|
| Ciclo | CG, GR, OCE, ARES | exceÃ§Ã£o na ordenaÃ§Ã£o topolÃ³gica / `CycleError` / DFS 3-cores |
| NÃ³ desconectado / ilha | **sÃ³ OpenConstructionERP** | union-find â†’ `component_finish` por ilha (evita float inflado) |
| Sem predecessor | todos | ES = inÃ­cio do projeto (`projectFloor`) |
| MÃºltiplos predecessores | todos | `max` dos bounds no forward, `min` no backward |
| Empate entre caminhos | **sÃ³ OpenConstructionERP** | desempate determinÃ­stico `(topo_rank, str(id))` |
| DuraÃ§Ã£o zero / milestone | CG (`type:'milestone'`, duration 0), PL (sentinelas) | â€” |
| Tarefa manual | CG, GR, PL | mantÃ©m datas do usuÃ¡rio, permanece na rede |

### 12.4 DecisÃ£o para o OpenWork
## 13. Quantidade e produtividade (Q Ã· Produtividade = DuraÃ§Ã£o)

### 13.1 Quem realmente implementa
| Sistema | Implementa? | Onde | FÃ³rmula real |
|---------|-------------|------|--------------|
| OpenProject | âŒ | â€” | nÃ£o existe quantidade/unidade/produtividade no WP |
| construction-gantt | âŒ | â€” | `duration` Ã© minuto de trabalho, informado |
| GanttReady | âŒ | â€” | `PlanDuration` em dias, informado |
| **OpenConstructionERP** | âœ… **Ãºnico com cadeia completa** | `schedule/service.py` (`compute_duration`, `estimate_fallback_duration_days`, `_FALLBACK_PRODUCTION_RATES`) | ver 13.2 |
| ProjectLibre | parcial (work/units/duration) | `pm/assignment/*` | `Work = Duration Ã— Units` (modelo MS Project, nÃ£o produtividade de obra) |
| ARES | âœ… conceitualmente | `tbServicos` (unidade), `tbProducao`, `tbMedicao` | quantidade Ã— unidade por serviÃ§o/frente/equipe; duraÃ§Ã£o **digitada**, nÃ£o derivada |

### 13.2 Cascata de derivaÃ§Ã£o de duraÃ§Ã£o do OpenConstructionERP (`compute_duration`)
```
Try 1: labor_hours explÃ­cito da posiÃ§Ã£o BOQ      â†’ dias = labor_hours / (hours_per_day Ã— crew)
Try 2: recursos alocados                          â†’ soma horas dos recursos
Try 3: fallback por unidade (_FALLBACK_PRODUCTION_RATES: labor-hours por 1 unidade, por unidade
       BOQ normalizada â€” mÂ³, mÂ², m, kg, unâ€¦)      â†’ estimate_fallback_duration_days(unit, qty, h/dia)
       marca metadata duration_source="estimated_fallback"
Try 4: proporcional ao custo                      â†’ round(total_cost/grand_total Ã— total_days),
       duration_source="cost_proportional"
SenÃ£o: 3 dias, duration_source="default_minimum"
sempre: max(1, â€¦) â€” nunca duraÃ§Ã£o zero
```
- **PadrÃ£o excelente e diretamente aproveitÃ¡vel:** cada duraÃ§Ã£o carrega a **proveniÃªncia**
  (`duration_source`) de como foi obtida. O planejador vÃª o que Ã© dado real e o que Ã© chute.
- `hours_per_day` vem do `WORK_CALENDARS` da regiÃ£o; `crew` (equipe) divide as horas.

### 13.3 Progresso por quantidade (`progress_math.py`) â€” o elo Q â†’ avanÃ§o
TrÃªs **tipos de percent-complete**, decisÃ£o de modelagem madura:
```
duration : RD = round(OD Ã— (1 âˆ’ pct/100))            â†’ o percentual Ã© a fonte da verdade
units    : pct = clamp(100 Ã— instalada / orÃ§ada)     â†’ o percentual Ã© DERIVADO da quantidade  â˜…
physical : pct e RD divergem legitimamente; pct = roll-up ponderado de steps
```
- â˜… Ã‰ exatamente o modelo que a obra precisa: **quantidade executada â†’ % â†’ avanÃ§o**, nÃ£o o inverso.
- `Decimal` fim-a-fim para dinheiro (nunca `float`); **nenhuma leitura de relÃ³gio** (`data_date` sempre
  injetada) â‡’ 100% determinÃ­stico e testÃ¡vel; freeze de remaining-duration em suspensÃ£o; avisos
  determinÃ­sticos de distorÃ§Ã£o de EVM; PV time-phased. ConvenÃ§Ã£o de contagem alinhada ao CPM.

### 13.4 Arredondamento, equipe e mÃºltiplos recursos
- **Arredondamento:** OCE usa `max(1, round(...))` â€” nunca zero, sempre inteiro de dias.
  `progress_math` usa `ROUND_HALF_UP` com quanta explÃ­citos (`0.01` dinheiro, `0.001` percentual).
- **Equipe:** entra como divisor de horas (`crew`), nÃ£o como recurso nomeado no cÃ¡lculo de duraÃ§Ã£o.
- **MÃºltiplos recursos:** OCE soma horas; ProjectLibre usa `units` por atribuiÃ§Ã£o; construction-gantt
  guarda `Assignment{taskId, resourceId, units}` sem usar no cÃ¡lculo.
- **Produtividade variÃ¡vel:** **nenhum** sistema modela produtividade que varia ao longo do tempo ou
  por local/pavimento. â†’ **lacuna do estado da arte; oportunidade real do OpenWork** (ver Â§28/Â§29).

### 13.5 O que o OpenWork deve extrair
1. `DuraÃ§Ã£o = Quantidade Ã· (Produtividade Ã— Equipe)`, com **`duration_source` obrigatÃ³rio** em cada
   atividade (medida / composiÃ§Ã£o / histÃ³rico / estimada / manual).
2. DuraÃ§Ã£o **derivada por padrÃ£o, sobrescrevÃ­vel manualmente** â€” e o override deve ser visÃ­vel.
## 14. Baseline e planejado Ã— real

### 14.1 Como cada sistema trata
| Sistema | Baseline | Planned | Actual | VariÃ¢ncia |
|---------|----------|---------|--------|-----------|
| OpenProject | âŒ (sÃ³ derived_dates) | start/due do WP | TimeEntry (horas) | â€” |
| **construction-gantt** | âœ… `Baseline{index 0-10, name, capturedAt, tasks:Map<id,Snapshot{start,end,duration}>}` | `task.start/end` + `task.computed` | `progress 0-100` | `getTaskBaselineVariance` |
| GanttReady | âœ… `Baseline.cs` (nome, captura) | `TaskItem.Plan*` | `TaskItem.Actual*`/`Complete` | `AnalysisService` |
| OpenConstructionERP | âŒ (nÃ£o mapeado) | `start_date/end_date` (persistido) | â€” (via `progress_math`) | â€” |
| **ProjectLibre** | âœ… `BaselineScheduleFields` (start/finish/duration por baseline#) | early dates | â€” | â€” |
| ARES | implÃ­cito (planejamento legado congelado) | `tbPlanejamento` | `tbProducao`/`tbMedicao` | `tbIndicadores` |

### 14.2 Detalhes dignos de nota

**construction-gantt** (`baseline.ts`, `baseline.test.ts`):
- `captureBaseline(project, index, {name})` â†’ snapshot imutÃ¡vel de `start/end/duration` por tarefa em
  `project.baselines[index]` (sobrescreve se jÃ¡ existir, preservando os demais Ã­ndices).
- `getTaskBaselineVariance(project, task, index)` â†’ `{start, end, duration}` = planejadoâˆ’baseline;
  `getTaskBaselineVarianceAll(project, index)` â†’ todas as tarefas de uma vez.
- **11 baselines** (0â€“10), igual MS Project; `capturedAt` Ã© `Date` automÃ¡tica. Testes confirmam:
  snapshot captura start/end/duration, sobrescriÃ§Ã£o por Ã­ndice, nome customizado.

**GanttReady:** `Baseline.cs` persistido; `AnalysisService` expÃµe `get_critical_path` como tool de IA
(`AiToolDefinitions.CriticalPathTool()`).

**ProjectLibre:** `BaselineScheduleFields` Ã© interface (`getBaselineStart/Finish/Duration(int numBaseline)`)
implementada por TaskSnapshot â€” separaÃ§Ã£o contrato/dado tÃ­pica do legado.

**ARES:** o "baseline" Ã© o **planejamento legado congelado** (`tbPlanejamentoLegado` com
INÃCIO/FIM/STATUS/%REAL) vs. planejamento novo (`tbPlanejamento`). LOB deriva do legado; mediÃ§Ã£o
(`tbMedicao`) e produÃ§Ã£o (`tbProducao`) fecham o ciclo no `tbIndicadores`.

### 14.3 LiÃ§Ãµes para o OpenWork
1. Baseline = snapshot imutÃ¡vel de `(inÃ­cio, fim, duraÃ§Ã£o, progresso, custo)` por atividade, com
   `Ã­ndice` (0â€“10), `nome`, `capturedAt`. construction-gantt Ã© o modelo mais limpo.
2. VariÃ¢ncia deve ser **derivada** (planejadoâˆ’baseline), nÃ£o persistida como cÃ³pia.
3. A distinÃ§Ã£o planejado/real se fecha com **produÃ§Ã£o apontada** (ARES) ou **% fÃ­sico derivado da
   quantidade** (OpenConstructionERP), nunca % digitado arbitrariamente.

---
## 15. Gantt

### 15.1 Arquitetura: de onde vÃªm os dados do Gantt?
| Sistema | Gantt armazena? | Fonte da verdade | RenderizaÃ§Ã£o |
|---------|-----------------|------------------|--------------|
| OpenProject | **nÃ£o** | WP (`start_date`/`due_date`) + `derived_dates` | `wp-timeline.ts` (Angular) lÃª o modelo |
| construction-gantt | **nÃ£o** | `schedule(project)` â†’ `task.computed` | renderer SVAR lÃª `computed` |
| GanttReady | parcial | `TaskItem` (ES/EF calculados e persistidos) | Blazor |
| OpenConstructionERP | parcial | `start_date/end_date` persistidos pelo service | React |
| ProjectLibre | nÃ£o (early/late/current no modelo vivo) | `TaskSchedule` (EARLY/LATE/CURRENT) | Swing |
| ARES | **sim** (planilha) | `tbPlanejamento` (datas digitadas) | Excel nativo |

### 15.2 Pipeline confirmado
```
MODEL (atividades + relaÃ§Ãµes + calendÃ¡rio) â†’ SCHEDULER â†’ DATES (ES/EF/LS/LF/slack) â†’ GANTT (renderer)
```
OpenProject, construction-gantt e ProjectLibre confirmam: o Gantt **nunca armazena** datas. GanttReady
e OpenConstructionERP persistem datas derivadas â€” conveniente, mas Ã© a classe de bug do R-05 (Â§12.4).

### 15.3 Componentes observados
- **OpenProject** `wp-timeline.ts` (`timeline-cell-renderer.ts`): renderer Angular read-only sobre WP/derived_dates.
## 16. LOB (Line of Balance)

### 16.1 Quem implementa
| Sistema | LOB? | Como |
|---------|------|------|
| OpenProject | âŒ | â€” |
| construction-gantt | âŒ | â€” |
| GanttReady | âŒ | â€” |
| OpenConstructionERP | âŒ | â€” |
| ProjectLibre | âŒ | â€” |
| **ARES** | âœ… **Ãºnico com LOB real** | `ARES..._LOB_PROFISSIONAL_FINAL_WORK.xlsx`: TEMPO horizontal (78 semanas), SERVIÃ‡OS/PAVIMENTOS vertical, HOJE dinÃ¢mico, 124 faixas, **derivada** (fÃ³rmulas sobre `tbPlanejamentoLegado`/CADASTRO) |

### 16.2 Arquitetura da LOB no ARES
- Planilha dedicada (19 abas: 18 oficiais + LINHA DE BALANÃ‡A) â€” componente **congelado/aprovado**.
- Eixo X = tempo (05/01/2026 â†’ 30/06/2027, datas rotacionadas 90Â°, meses nÃ­vel 1).
- Eixo Y = serviÃ§os/pavimentos.
- **0 dados independentes**: toda faixa Ã© fÃ³rmula sobre o planejamento legado â†’ LOB Ã© **visÃ£o derivada
  pura**, nunca armazÃ©m.
- GovernanÃ§a: consolidaÃ§Ã£o no oficial Ã© decisÃ£o humana futura (nÃ£o automÃ¡tica).

### 16.3 DecisÃ£o para o OpenWork
A LOB, assim como o Gantt, Ã© **sempre uma visÃ£o derivada** sobre o modelo operacional. NÃ£o possui
engine prÃ³pria; reusa o mesmo scheduling. Para o OpenWork, a LOB serÃ¡ uma projeÃ§Ã£o do **cronograma
por unidade repetitiva** (pavimentos, apartamentos, torres) derivada das atividades e suas relaÃ§Ãµes â€”
**nunca** um motor separado. â†’ **Conceito confirmado: LOB = visÃ£o, nunca modelo.**

---
## 17. Recursos

### 17.1 Como cada sistema modela
| Sistema | Pessoas | Equipes | Equipamentos | Materiais | CalendÃ¡rio por recurso | Leveling |
|---------|---------|---------|--------------|-----------|------------------------|----------|
| OpenProject | â€” (plugin custos) | â€” | â€” | â€” | â€” | â€” |
| construction-gantt | â€” | â€” | â€” | â€” | âœ… (`Resource.calendarId`) | âŒ |
| GanttReady | âœ… `Resource` | â€” | â€” | â€” | â€” | âŒ |
| OpenConstructionERP | â€” | `crew` (divisor de horas) | â€” | BOQ items | â€” | âœ… (`schedule_advanced/leveling.py`) |
| ProjectLibre | âœ… Assignment+Resource | â€” | â€” | â€” | âœ… | âœ… |
| ARES | â€” | âœ… `tbEquipes` | â€” | â€” | â€” | â€” |

### 17.2 Detalhes

**construction-gantt** (`types.ts`): `Resource{id, name, calendarId?}` + `Assignment{id, taskId,
resourceId, units?}` (1.0=100%, 0.5=meio perÃ­odo, >1=superalocado). Renderer sinaliza `OverAllocated`.
CalendÃ¡rio por recurso **existe no tipo** e o engine reconcilia com o da tarefa (recurso vence para
atividades que dependem dele).

**GanttReady:** `Resource.cs` + `ResourceAssignment.cs`; `AnalysisService` expÃµe recursos por tarefa.

**OpenConstructionERP:** recursos entram como **`crew`** em `compute_duration` (horas totais Ã· crew Ã·
hours_per_day). `schedule_advanced/leveling.py` Ã© mÃ³dulo dedicado a **resource leveling** (Ãºnico com
leveling real alÃ©m do ProjectLibre).

**ARES:** `tbEquipes`, `tbRecursos`, `tbEquipeRecursos`, `tbServicoRecursos` â€” equipe Ã© entidade de
primeira classe com produtividade; a rede de precedÃªncias R6 detecta **dependÃªncia de equipe comprovada**
(mesma equipe + datas sequenciais) em `gerar_rede_precedencias.py:224-241`.

### 17.3 Onde recursos vivem (modelo Ã— planejamento Ã— scheduler)
- **construction-gantt/GanttReady/ProjectLibre**: recursos sÃ£o parte do **modelo** (existem com ou sem
  estarem alocados) e o **scheduler** os reconcilia com calendÃ¡rios.
- **OpenConstructionERP**: recursos sÃ£o parte do **planejamento** (entram no cÃ¡lculo de duraÃ§Ã£o via crew).
- **ARES**: recursos sÃ£o parte do **planejamento/equipe** (produtividade por equipe).

### 17.4 DecisÃ£o para o OpenWork
Recursos devem ser **parte do modelo** (independente de alocaÃ§Ã£o), com calendÃ¡rio prÃ³prio opcional.
A **produtividade da equipe** (ARES) Ã© o conceito central para obra â€” nÃ£o o "recurso" abstrato do MS
Project. Leveling (OpenConstructionERP) Ã© desejÃ¡vel como estÃ¡gio posterior. â†’ Separar `Equipe


## 18. Testes

### 18.1 Cobertura observada por sistema

| Sistema | Engine | Calendar | Deps/Relations | CPM/Float | Baseline |
|---------|--------|----------|----------------|-----------|----------|
| OpenProject | `set_schedule_service_working_days_spec.rb` (~140 linhas, forward + working days) | ✅ | ❌ | ❌ | — |
| **construction-gantt** | ✅ `schedule.test.ts` (~200+ linhas): forward, FS chain, lag+, diamond convergence, SS, FF, SF, lag negativo, milestone, manual | ✅ | ✅ (topo sort) | ✅ (totalSlack, freeSlack, critical, neg slack) | ✅ `baseline.test.ts`: snapshot, sobrescrição |
| GanttReady | ✅ `ScheduleEngineTests.cs`: serial, paralelo, merge, FS/SS/SF/FF, lag, float, critical | ✅ | ✅ | ✅ | — |
| OpenConstructionERP | ✅ `test_work_calendar_rest_days_do_not_conflict.py` (gate doc), cascade `compute_duration` | ✅ | ✅ | ✅ | — |
| ProjectLibre | ❌ (testes JUnit não priorizados) | — | — | — | — |
| ARES | ❌ (planilha, sem testes automatizados) | — | ✅ (R10 ciclo) | — | — |

### 18.2 Casos extremos encontrados nos testes
| Caso | Onde | Tratamento |
|------|------|-----------|
| Ciclo | CG `topologicalSort`, GR lança, OCE `CycleError`, ARES R10 DFS | exceção explícita |
| Sem predecessor | CG (projectFloor), GR (ES=0) | ancora no início do projeto |
| Diamond (múltiplos pred.) | CG `diamond convergence` | `max` dos bounds |
| SS ties | CG `SS link` | ES alinhado + lag |
| Lag negativo (lead) | CG `negative lead` | subtractWorkingMinutes |
| Milestone (duração 0) | CG `type:'milestone'` | duração zero |
| Tarefa manual | CG, GR | mantém datas do usuário |
| FF/SF | CG `FF link`, `SF link` | bounded ES via EF-lag |
| Sink (sem sucessor) | CG, GR (projectDuration) | LF = project finish |

### 18.3 Testes que deveriam existir no OpenWork (recomendados)
1. **Forward pass**: FS/SS/FF/SF com lag +/-, diamond, milestone, manual, projectFloor.
2. **Backward pass**: sink → projectFinish, múltiplos sucessores, propagação de folga.
3. **Float**: totalSlack, freeSlack, isCritical (==0 e <0), negative slack preservation.
4. **Calendário**: fim de semana, feriado, meio-dia, timezone, `data+duração` e `data-duração`.
5. **Ciclo**: detecta e lança com mensagem listando os nós.
6. **Q÷Produtividade**: crew, fallback rates, duração zero → 1, arredondamento ROUND_HALF_UP.
7. **Progresso**: tipo units → %, tipo duration → RD, physical roll-up.
8. **Baseline**: snapshot imutável, sobrescrição por índice, variância derivada.
9. **EAP→Serviço→Atividade**: rastreabilidade WBS, 1→N, sem datas na EAP.

---`n## 19. Comparação final (matriz)

> Preenchida somente quando houve evidência no código local.

| Capacidade | OpenProject | Constr. Gantt | OpenCon.ERP | GanttReady | ProjectLibre | ARES |
|-----------:|:-----------:|:-------------:|:-----------:|:----------:|:------------:|:----:|
| EAP/WBS | outline codes | parent→summary | WBS hierarchy | — | outline codes | tbEAP |
| Hierarquia | pai/filho WP | task→summary | activity tree | — | task→summary | serv→frente |
| Relações | ✅ `Relation` | ✅ `Link` | ✅ `ScheduleRelationship` | ✅ `TaskRelation` | ✅ `Dependency` | ✅ `tbRede` |
| FS | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| SS | ✅ (precedes) | ✅ | ✅ | ✅ | ✅ | — |
| FF | ✅ (precedes) | ✅ | ✅ | ✅ | ✅ | — |
| SF | ✅ (precedes) | ✅ | ✅ | ✅ | ✅ | — |
| Lag/Lead | ✅ `lag` | ✅ lag min | ✅ `lag_days` | ✅ `Lag` int | ✅ | ✅ `DEFASAGEM` |
| Calendário | ✅ wd+exc | ✅ ww+exc | ✅ regional | ✅ project cal | ✅ WorkingCal | — |
| Scheduling | ✅ forward | ✅ fwd+back | ✅ fwd+back | ✅ fwd+back | ✅ 3-pass | manual |
| CPM | ❌ | ✅ (scheduler) | ✅ (módulo) | ✅ (scheduler) | ✅ (modelo) | ❌ |
| Float | ❌ | ✅ TF+FF | ✅ TF+FF | ✅ TF+FF | ✅ | ❌ |
| Critical Path | ❌ | ✅ (TF<=0) | ✅ (Longest) | ✅ (TF<=0) | ✅ inc | ❌ |
| Quantidade | ❌ | ❌ | ✅ BOQ+qty | ❌ | parcial | ✅ qtd×un |
| Produtividade | ❌ | ❌ | ✅ Q÷prod | ❌ | ❌ | ✅ equipe |
| duration_source | ❌ | ❌ | ✅ obrigatório | ❌ | ❌ | — |
| Recursos | ❌ | ✅ modelo | ✅ crew | ✅ modelo | ✅ assign | ✅ equipe |
| Leveling | ❌ | ❌ | ✅ módulo | ❌ | ✅ | — |
| Baseline | ❌ | ✅ (0-10) | ❌ | ✅ | ✅ interface | implícito |
| Actual | TimeEntry | progress% | progress_math | Actual* | — | tbProducao |
| Produção | ❌ | ❌ | ❌ | ❌ | ✅ (work) | ✅ apont. |
| Gantt | ✅ Angular | ✅ SVAR wrap | ✅ React | ✅ Blazor | ✅ Swing | ✅ Excel |
| LOB | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ derivada |

---

(produtividade, calendÃ¡rio)` de `Recurso (pessoa/equipamento genÃ©rico)`.

---

## 20. Decisões para o OpenWork

### 20.1 Arquitetura recomendada (validada pelas referências)
```
OBRA (início, calendário, feriados, região)
│
├── EAP (estrutura apenas: wbs, nome, nivel, tipo, pai, ordem, fundamentacao, condicao)
│     → não contém datas, duração, relações nem progresso
│
├── MODELO OPERACIONAL (fonte única da verdade)
│   ├── Serviço         (escopo: quantidade, unidade, produtividade, eapNodeId, equipe)
│   ├── Atividade       (nó agendável: serviço, contexto/local, datas MANUAIS opcionais)
│   ├── Relação         (predecessor→sucessor, tipo FS/SS/FF/SF, lag)
│   ├── Calendário      (jornada, dias úteis, feriados, exceções, por obra/recurso)
│   └── Equipe          (produtividade, calendário próprio, custo)
│
├── SCHEDULING ENGINE (função pura, testável sem banco)
│   ├── Input  = (atividades, relações, calendário, opções)
│   ├── Forward Pass   → ES, EF
│   ├── Backward Pass  → LS, LF
│   ├── Float          → TF, FF (negativo preservado), isCritical
│   └── Longest Path   → cadeia data-driving (não só float)
│
├── VISUALIZAÇÕES (nunca armazenam; reconstroem do modelo+scheduler sob demanda)
│   ├── Gantt          (barras = ES..EF, críticas destacadas, slack como folga)
│   └── LOB            (unidades repetitivas: pavimentos/torres, derivada)
│
└── EXECUÇÃO
    ├── Frente         (contexto/local de execução)
    └── Produção       (apontamento de quantidade → % físico via progress_math)
```

### 20.2 Respostas fundamentadas (à questão arquitetural central)

| Pergunta | Resposta | Por quê (evidência) |
|----------|----------|---------------------|
| O Gantt deve armazenar planejamento? | **Nunca.** | OpenProject/CG/PL: Gantt = visualização de `computed`. Editar data = editar entrada do motor. |
| A LOB deve armazenar planejamento? | **Nunca.** | ARES: LOB = visão derivada por unidade repetitiva (fórmulas sobre planejamento). |
| CPM deve ser persistido ou derivado? | **Derivado** (cache invalidável). | Float negativo só existe no cálculo (CG ADR-003); persistir gera mentira (R-05). |
| Datas devem ser persistidas ou calculadas? | **Calculadas**; persistir só início da obra e datas manuais. | Motor refaz o resto a partir das entradas. |
| Relações devem ser entidades independentes? | **Sim.** | Independentes da hierarquia; permitem FS/SS/FF/SF/lag; unique por par. |
| EAP deve gerar atividades automaticamente? | **Parcialmente** (1 serviço → N atividades, conforme contexto/local). | Rastreabilidade WBS mantida; produto ganha liberdade. |
| Serviço e Atividade são entidades diferentes? | **Sim.** | Serviço = escopo (qtd/unidade/produtividade); Atividade = nó agendável (tempo). |
| Produção pode alterar planejamento diretamente? | **Não.** | Produção alimenta % físico e datas reais; planejamento muda via motor + humano. |
| O Agente Planejador poderá alterar o modelo? | **Propor, não impor.** | Agente detecta problemas, propõe com justificativa; humano aprova. |

---`n## 21. Fonte única da verdade

### 21.1 Veredito

A **fonte única da verdade do planejamento no OpenWork é o MODELO OPERACIONAL** composto por:
`(Serviços, Atividades, Relações, Calendário, Equipes, opções da obra)`.

**Justificativa (triangulação das referências):**
- **OpenProject**: Work Package é a fonte do que existe; derived_dates são projeções. *Mas* falha: sem
  backward pass (sem float/CPM) → incompleto para obra.
- **construction-gantt**: `schedule(project)` é **função pura**; `task.computed` é projeção read-only;
  o `Project` (entradas) é a verdade. *Padrão mais limpo e o mais recomendado para o OpenWork.*
- **GanttReady**: `TaskItem` persiste datas derivadas → cria duas fontes (modelo × cópia). *Erro a evitar.*
- **OpenConstructionERP**: modelo de atividades + relações é a verdade; CPM é função pura derivada.
- **ProjectLibre**: TaskSchedule (early/late/current) é vivo no modelo; sentinelas ancoram.
- **ARES**: planilha é a verdade (por ser o meio); LOB é fórmula — confirma que visões derivadas não
  precisam de armazém próprio.

### 21.2 Invariantes do modelo OpenWork (decididas)
1. EAP nunca contém tempo (datas, duração, progresso).
2. Toda data agendada nasce do scheduling engine; nunca digitada como "a data".
3. Scheduling é função pura: `(entradas) → (datas, float, críticas)`. Sem ORM dentro do motor.
4. CPM/float são **derivados**; cache com hash das entradas, nunca persistidos como verdade.
5. Gantt e LOB são **visões** reconstruídas do modelo+engine a cada render.
6. Relações são entidades próprias, independentes da hierarquia.
7. Progresso avança por **quantidade executada** (tipo `units`), nunca por % arbitrário.
8. Produtividade de equipe varia por contexto/local — atributo da **atividade**, não constante global.
9. Agente Planejador propõe; humano aprova mudanças críticas.
10. Toda alteração propaga pelo motor antes de persistir.

### 21.3 Riscos arquiteturais identificados
| ID | Risco | Origem | Mitigação |
|----|-------|--------|-----------|
| R-01 | Motor forward-only sem backward → sem float/CPM | OpenProject | Exigir forward+backward (CG/GR/OCE) |
| R-02 | Persistir datas derivadas dessincroniza | GanttReady | Datas derivadas = cache invalidável |
| R-03 | Gantt como fonte da verdade | ARES | Gantt = visão; engine é verdade |
| R-04 | Dois motores com calendários diferentes | OpenConstructionERP | Um motor, um calendário canônico |
| R-05 | Float persistido muda sem replanejar | GanttReady | Float derivado; nunca persistido |
| R-06 | Arrastar-barras sem propagar | (comum) | Editar entrada → motor → renderer |
| R-07 | EAP ganha datas e vira cronograma | (tentação) | Invariante 1: EAP sem tempo |
| R-08 | % avançado digitado (não derivado) | (comum) | Invariante 7: Q executada → % |

---`n## 22. Relação com a EAP existente

A EAP atual (81 nós, 10 disciplinas, 24 pacotes, 47 trabalhos) **permanece inalterada** nesta fase.

**Mapeamento decidido (para a próxima fase):**
- **Nós DISCIPLINA/PACOTE** → continuam **estruturais** (não geram datas).
- **Nós TRABALHO** → originam **Serviços** (1 trabalho → 1+ serviços, conforme locais).
- **Serviço** → origina **Atividades** (1 serviço × N contextos/locais = N atividades).
- **Atividades** → possuem **Relações** (FS/SS/FF/SF+lag) → alimentam o **Scheduling**.
- **Rastreabilidade**: cada Atividade carrega `eapNodeId` (e `wbs_code` derivado) → volta à EAP.

**Permitirá (futuro):** EAP → Planejamento → CPM → Gantt → LOB → Frentes → Produção → Controle →
Memória → Agente Planejador — sobre **um único modelo operacional**, sem múltiplas fontes de verdade.

---`n## 23. Relação com o Agente Planejador

Não implementar nesta fase. Apenas **pontos de extensão identificados** (o agente lerá, não alterará diretamente):
- EAP (estrutura, WBS, condicionantes);
- Serviços (qtd/unidade/produtividade/duration_source);
- Atividades (datas manuais, calendário);
- Relações (tipo, lag, ciclos);
- CPM (float, críticas, Longest Path);
- Gantt/LOB (visões para diagnóstico);
- Produção (qtd real, %, atraso);
- Histórico (baseline, variações);
- Regras (invariantes 1–10).

O agente **propõe replanejamento com justificativa**; a aprovação de mudanças críticas é humana.

---`n## 24. Pontos fortes e fracos das referências

| Referência | Pontos fortes (aproveitar) | Pontos fracos (rejeitar) |
|-----------|---------------------------|-------------------------|
| **OpenProject** | Relações ricas (8 tipos), convenção canônica, API v3, ancestrais automáticos | **Sem CPM/backward**; datas no WP; monolito Rails |
| **construction-gantt** | Função pura, imutável, ADRs, 11 baselines, float negativo, MSPDI | Sem recursos reais, sem Q/LOB |
| **GanttReady** | Engine sem estado, EV, tools IA, calendário por projeto | **Persiste float** (R-05), datas derivadas no banco |
| **OpenConstructionERP** | **Q÷Produtividade completa**, duration_source, progress_math, LOB-ready | **Dois motores**, Q sem calendário (bug doc), sem baseline |
| **ProjectLibre** | CPM incremental 3-pass, sentinelas, snapshots, MS Project compat | Código legado (Swing), interface/dados acoplados |
| **ARES** | Produtividade por equipe, LOB derivada, produção↔planejamento | **Planilha** (sem engine), sem baseline, sem CPM, congelado |

---`n## 25. Conceitos aproveitáveis vs rejeitados

### Aproveitáveis (com reimplementação própria)
1. **construction-gantt**: scheduling função pura + imutável; float negativo preservado; 11 baselines; baseline como snapshot.
2. **OpenConstructionERP**: `compute_duration` com cascata + `duration_source` obrigatório; `progress_math` (duration/units/physical); leveling módulo separado; union-find por ilha; longest path.
3. **ProjectLibre**: sentinelas Start/End; 3-pass incremental; EARLY/LATE/CURRENT.
4. **OpenProject**: relações canônicas com `reverse_if_needed`; propagação de ancestrais para scheduling.
5. **ARES**: produtividade por equipe; LOB como visão derivada; R6 dependência de equipe comprovada.

### Rejeitados
1. OpenProject: motor forward-only sem backward (sem CPM).
2. GanttReady: persistir float/datas derivadas como fonte da verdade.
3. OpenConstructionERP: dois motores com calendários diferentes.
4. ARES: usar planilha como modelo; falta de engine.
5. ProjectLibre: acoplamento interface/modelo (Swing).

---`n## 26. Riscos e dúvidas para validação futura

### Riscos (listados em §21.3): R-01 a R-08.

### Dúvidas que precisam de validação futura (fora do escopo desta fase)
1. **D-01:** A EAP atual de 81 nós precisa de ajuste de granularidade para gerar serviços, ou está no nível correto? (especialmente os 47 trabalhos → serviços).
2. **D-02:** O calendário único por obra é suficiente, ou precisamos de calendário por frente/pavimento logo de início?
3. **D-03:** A produtividade de equipe deve ter curva de aprendizado ao longo das repetições ou constante por enquanto? (nenhum sistema modela curva; oportunidade).
4. **D-04:** A integração produção→planejamento será em tempo real (apontamento diário) ou em lotes semanais?
5. **D-05:** A equipe de obra (pedreiro, servente, mestre) deve ser entidade independente ou atributo da atividade?
6. **D-06:** Como representar restrições físicas (ex.: laje só depois de 7 dias de cura) — como lag fixo FS ou como calendário de recurso ocioso?
7. **D-07:** O scheduling deve rodar completo a cada mudança ou incremental (como ProjectLibre)?

---
## 27. Relação com a EAP existente (81 nós)

### 27.1 Decisão: EAP → Serviço → Atividade
A EAP atual (81 nós, 10 disciplinas, 24 pacotes, 47 trabalhos) **não deve ser recriada** — é WBS de rastreabilidade, sem tempo. A relação recomendada:

```
EAP (estrutura, sem tempo)
  ↓
Serviço (escopo executável: qtd/unidade/produtividade — derivado dos nós TRABALHO/EAP)
  ↓
Atividade (nó agendável: tempo, dono, frente, local — gerado por contexto)
  ↓
Relações (FS/SS/FF/SF+lag) entre Atividades
  ↓
Scheduling Engine → datas, float, críticas
```

### 27.2 Quem vira o quê
| Nó da EAP | Vira… | Por quê |
|-----------|-------|---------|
| DISCIPLINA (10) | Continua **estrutural** (agrupador WBS) | Não é escopo executável |
| PACOTE (24) | Continua **estrutural** ou vira **Serviço** (se for escopo atômico) | Depende da granularidade |
| TRABALHO (47) | Vira **Serviço** (ou decompõe em vários) | É o escopo executável mínimo |
| Nós de contexto (obra/fase) | Continua **estrutural** | Define escopo da obra |

### 27.3 Regras de derivação
1. Um nó TRABALHO gera **um ou mais Serviços** (pode decompor por local/frente).
2. Um Serviço gera **uma ou mais Atividades** (por pavimento, apartamento, torre — contexto repetitivo).
3. Uma Atividade pertence a **um único contexto** (frente+local+unidade) — não a vários.
4. A **rastreabilidade WBS** é mantida: `atividade.wbs_code` → herda do nó EAP pai (via serviço).
5. Um nó EAP pode gerar **múltiplas atividades** (ex.: "Concreto LAJE" → uma por pavimento).
6. Uma atividade **não pertence a mais de um nó EAP** (evita ambiguidade de rastreabilidade).

### 27.4 Validação futura (D-01)
A granularidade atual dos 47 trabalhos precisa ser validada: são granulares o suficiente para serem serviços, ou precisam de decomposição? Isso será validado na fase de implementação (fora do escopo desta fase).

---
## 28. Relação com o Agente Planejador

### 28.1 Pontos de extensão necessários (leitura)
O Agente Planejador precisará ler, no futuro:
- **EAP**: estrutura WBS, níveis, rastreabilidade (`obra-eap-types.ts`, `obra-eap-reference.ts`).
- **Serviços**: escopo, quantidade, unidade, produtividade, `duration_source`.
- **Atividades**: datas, duração, progresso, contexto (frente/local), status.
- **Relações**: tipo, lag, predecessor/successor.
- **Calendário**: dias úteis, feriados, exceções.
- **CPM**: float, caminho crítico, folgas.
- **Gantt**: visão temporal (derived from model).
- **LOB**: visão por unidade repetitiva (derived from model).
- **Produção**: quantidade executada, medição, avanço.
## 29. Comparação final (matriz)

| Capacidade | OpenProject | Construction Gantt | OpenConstructionERP | GanttReady | ProjectLibre | ARES |
|-------------|-------------|-------------------|---------------------|------------|--------------|------|
| EAP/WBS | Summary WP (hierárquico) | `parent` (task/summary) | WBS em atividade | Task parentId | Outline codes | `tbEAP` (47 trabalhos) |
| Hierarquia | WP tree | summary→task | Activity.tree | Task→subtask | Task hierarchy | EAP→Serviço→Frente |
| Relações | 8 tipos + lag | FS/SS/FF/SF + lag | FS/FF/SS/SF + lag | FS/SS/SF/FF + Lag | FS/SS/FF/SF | FS (R1/6/10) |
| FS | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| SS | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| FF | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| SF | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| Lag/Lead | ✅ (dias úteis) | ✅ (min trab) | ✅ (dias) | ✅ (dias) | ✅ (calendário) | ✅ (dias) |
| Calendário | ✅ (monolítico) | ✅ (workWeek+exceptions) | ✅ (WORK_CALENDARS) | ✅ (por projeto) | ✅ (WorkingCalendar) | ❌ (sequencial) |
| Scheduling | ✅ (forward only) | ✅ (função pura) | ✅ (`schedule`+`cpm`) | ✅ (ScheduleEngine) | ✅ (3-pass) | ❌ (manual) |
| CPM | ❌ | ✅ (TF+FF+neg) | ✅ (TF+FF+longest path) | ✅ (TF+FF) | ✅ (incremental) | ❌ |
| Float | ❌ | ✅ (derivado) | ✅ (derivado) | ✅ (persistido — erro) | ✅ (early/late) | ❌ |
| Critical Path | ❌ | ✅ (isCritical) | ✅ (longest_path) | ✅ (IsCritical) | ✅ (CriticalPath) | ❌ |
| Quantidade | ❌ | ❌ | ✅ (BOQ+qty) | ❌ | ❌ | ✅ (qtd×un) |
| Produtividade | ❌ | ❌ | ✅ (Q÷prod→duração) | ❌ | ❌ | ✅ (equipe) |
| Recursos | parcial (plugin) | ✅ (types) | ✅ (crew) | ✅ (Resource) | ✅ (Assignment) | ✅ (equipes) |
| Baseline | ❌ | ✅ (0-10) | ❌ | ✅ (Baseline.cs) | ✅ (snapshots) | implícito (legado) |
| Actual | TimeEntry | progress 0-100 | ❌ | Actual*/Complete | ❌ | tbProducao/tbMedicao |
| Produção | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ (tbProducao) |
| Gantt | ✅ (wp-timeline) | ✅ (SVAR) | ✅ (React) | ✅ (Blazor) | ✅ (Swing) | ✅ (Excel) |
| LOB | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ (124 faixas) |

> **Nota:** preenchido somente quando houve evidência no código/documentação local (conforme regra da fase).

---
## 30. Documentação do produto (decisões permanentes)

| O que é | Por que existe | Responsável | De onde vem | Quem consome | Derivado? | Persistido? | Invariantes |
|---------|---------------|-------------|-------------|--------------|-----------|-------------|-------------|
| EAP/WBS | Rastreabilidade de escopo | Modelo Obra-EAP | OpenWork existente | Serviços, WBS code | Não | Sim (81 nós) | Sem tempo |
| Serviço | Escopo executável | Derivado da EAP | EAP (TRABALHO/PACOTE) | Atividades | Parcialmente | Sim (a gerar) | qtd/unidade/produtividade |
| Atividade | Nó agendável | Planejamento | Serviço + contexto | Scheduler, Gantt, LOB | Não (entrada) | Sim | duração ≠ 0 (exceto milestone) |
| Relação | Precedência | Planejamento | Usuário/Agente | Scheduler | Não | Sim | tipo canônico, unique par |
| Calendário | Dias úteis | Planejamento | Obra/region | Scheduler | Não | Sim | Mon-Fri default |
| Scheduling Engine | Calcular datas | Planejamento | Atividades+Relações+Calendário | Gantt, LOB, CPM | Sim (derivado) | Não (cache apenas) | Função pura |
| CPM/Float | Caminho crítico | Análise | Scheduler | Relatórios, Agente | Sim (derivado) | Não (cache apenas) | TF ≤ 0 = crítico |
| Gantt | Visão temporal | Visualização | Scheduler+Modelo | Usuário | Sim (visão) | Não | Read-only do modelo |
| LOB | Visão repetitiva | Visualização | Scheduler+Modelo | Usuário | Sim (visão) | Não | Read-only do modelo |
| Produção | Avanço real | Execução | Campo/apontamento | Planejamento (feed) | Não | Sim (apontamentos) | Decimal, data_date injetada |

---

- **Histórico**: alterações anteriores, baselines.

### 28.2 Pontos de extensão necessários (proposta)
O Agente poderá **propor** (nunca impor automaticamente):
## 31. Conclusão

### 31.1 Resposta à questão central (§20)
> **Como construir o motor de planejamento do OpenWork sem cometer os mesmos erros dos sistemas de referência?**

**Resposta:** Construir um **scheduling engine puro e imutável** (função `(atividades, relações, calendário) → (datas, float, críticas)`), sobre um **modelo operacional** que é a fonte única da verdade (Serviços + Atividades + Relações + Calendário + Equipes). O CPM/float é **derivado** (não persistido como fonte). Gantt e LOB são **visões** reconstruídas a cada render. A EAP existente é WBS de rastreabilidade (sem tempo) que gera Serviços, que geram Atividades. O Agente Planejador propõe, não impõe.

### 31.2 Resposta à questão arquitetural (§21)
> **Qual arquitetura permite que EAP, Serviços, Atividades, Relações, Calendários, CPM, Gantt, LOB, Frentes e Produção trabalhem sobre um único modelo operacional?**

**Resposta:** Arquitetura em camadas:
```
EAP (WBS, sem tempo) → Serviço (escopo) → Atividade (nó agendável) + Relações
  → Scheduling Engine (função pura) → Datas/CPM/Float (derivados, cache invalidável)
    → Gantt + LOB (visões) ← Produção (alimenta % real via quantidade executada)
```
Tudo sobre um único modelo operacional, com propagação pelo motor antes de persistir.

### 31.3 Erros dos sistemas de referência a evitar
| Erro | Sistema | Mitigação OpenWork |
|------|---------|-------------------|
| Motor forward-only sem backward/CPM | OpenProject | Exigir forward + backward (CG/GR/OCE) |
| Persistir datas/float derivados | GanttReady | Derivados = cache invalidável |
| Dois motores com calendários diferentes | OpenConstructionERP | Motor único, calendário unificado |
| Gantt/planilha como modelo | ARES | Gantt é visão, nunca modelo |
| Acoplamento interface/dados | ProjectLibre | Separação engine/renderer |
| % de progresso digitado | todos (menos OCE) | Progresso derivado da quantidade (tipo `units`) |
| Sem rastreabilidade de duração | todos (menos OCE) | `duration_source` obrigatório em cada atividade |

### 31.4 Forças a aproveitar (reimplantar com arquitetura própria)
- **construction-gantt**: scheduling função pura + imutável; float negativo preservado; 11 baselines.
- **OpenConstructionERP**: `compute_duration` com cascata + `duration_source`; `progress_math` (duration/units/physical); union-find por ilha; longest path.
- **ProjectLibre**: sentinelas Start/End; 3-pass incremental; EARLY/LATE/CURRENT.
- **OpenProject**: relações canônicas; propagação de ancestrais.
- **ARES**: produtividade por equipe; LOB como visão derivada; R6 dependência de equipe comprovada.

### 31.5 Estado da investigação
- **Repositórios analisados:** 6 (OpenProject, construction-gantt, OpenConstructionERP, GanttReady, ProjectLibre, ARES).
- **gantts-app:** não encontrado localmente (fora da matriz).
- **Arquivos relevantes analisados:** ~70+ (modelos, services, engines, algoritmos, testes, schemas).
- **Motores identificados:** 4 scheduling engines (OpenProject, construction-gantt, GanttReady, OpenConstructionERP) + 1 CPM (OpenConstructionERP `cpm.py`) + 1 incremental (ProjectLibre).
- **Modelos identificados:** WorkPackage (OP), Task+Link+Calendar+Baseline (CG), TaskItem+Relation+Baseline+Resource (GR), Activity+Relationship+OCE Scheduler+CPM (OCE), TaskSnapshot+Sentinel (PL), Serviço+Frente+Equipe+Produção (ARES).
- **Testes relevantes analisados:** ~50+ (forward/backward pass, FS/SS/FF/SF, lag+/-, diamond, milestone, manual, cycle, baseline snapshot, calendar, progress math).
- **Decisões arquiteturais:** 10 invariantes do modelo OpenWork (§21.2) + separação Serviço/Atividade + scheduling função pura + CPM derivado + Gantt/LOB como visões + Agente propõe-não-impoem.
- **Riscos identificados:** R-01 a R-08 (§21.3).
- **Conceitos recomendados:** 13 (§25).
- **Conceitos rejeitados:** 5 (§25).
- **Dúvidas para validação futura:** D-01 a D-07 (§26).

---
## 32. Veredito

**APROVADA PARA PRÓXIMA FASE**

A investigação apresentou evidências suficientes (6 repositórios, ~70 arquivos, 4 motores, 50+ testes) para decidir a arquitetura de planejamento do OpenWork. O modelo operacional único, com scheduling engine puro, CPM derivado, Gantt/LOB como visões, EAP→Serviço→Atividade, e Agente Planejador como proponente (não impõedor) é fundamentado nas melhores práticas encontradas e evita os erros identificados nos sistemas de referência.

A próxima fase pode iniciar a implementação do modelo operacional (Serviço, Atividade, Relação, Calendário, Scheduling Engine) sobre a EAP existente de 81 nós, com os invariantes e riscos aqui documentados.

---

**FIM DA FASE 06.3 — ENGENHARIA REVERSA DOS MODELOS DE PLANEJAMENTO**

- Reordenação de atividades (mudança de relações).
- Ajuste de produtividade/duração (baseado em histórico).
- Rebalanceamento de equipes/frentes.
- Antecipação/atraso de atividades não-críticas.
- Recomendação de baseline (quando capturar).
- Detecção de problemas: float negativo, atrasos, conflitos de recurso.

### 28.3 Restrições ao Agente
- **Nunca** alterar dados críticos sem aprovação humana.
- **Nunca** modificar a EAP (é estrutura de rastreabilidade).
- **Sempre** justificar propostas com base no modelo (evidência, não opinião).
- **Nunca** persistir alterações diretamente — propostas passam por serviço de aprovação.
- O Agente opera sobre **cópia de trabalho** do modelo; o humano aprova → merge.

### 28.4 Decisão arquitetural
O Agente é um **consumidor + produtor de propostas**, nunca um escritor direto do modelo. O modelo operacional permanece a fonte única da verdade; o agente é um "oexterno" que sugere mutações.

---


