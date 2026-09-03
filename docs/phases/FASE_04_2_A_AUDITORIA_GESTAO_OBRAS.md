# FASE 04.2-A â€” AUDITORIA DA GESTÃƒO DE OBRAS EXISTENTE (read-only)

> **Data:** 2026-01-09 Â· **Tipo:** auditoria somente leitura â€” nenhum cÃ³digo alterado.
> **Clone:** `OPENWORK-LAB\openwork`.

## 1. Objetivo
Descobrir a fonte atual da entidade **Obra** no OpenWork e o caminho tÃ©cnico para evoluir
para mÃºltiplas obras (`+ Nova obra Â· Obra A Â· Obra B Â· â€¦`) sem criar segunda fonte de
verdade nem contaminar o Core.

## 2. Escopo
- NÃºcleo genÃ©rico: `domains/*` (registro/navegaÃ§Ã£o/roteamento) e shell.
- DomÃ­nio Engenharia: `domains/engenharia/obra/*`.
- ComparaÃ§Ã£o com entidades genÃ©ricas existentes (Workspace) e mÃ³dulos criados
  (EAP, Planejamento V1).

## 3. Arquivos auditados
```text
apps/app/src/react-app/domains/engenharia/obra/
â”œâ”€â”€ obra-types.ts            (Obra, ObraEapSummary, ObraCaracterizacao, ObraModule)
â”œâ”€â”€ obra-data.ts             (OBRA_MODELO_ID / OBRA_MODELO / OBRAS_MODELO / findObraModelo)
â”œâ”€â”€ obra-routes.ts           (DOMAIN_ENGENHARIA_ID, obraRoute, engenhariaDomainHome, isObraModule)
â”œâ”€â”€ obra-navigation.ts       (buildEngenhariaNavigation: Engenhariaâ†’Obrasâ†’Obraâ†’mÃ³dulos)
â”œâ”€â”€ obra-store.ts            (useObraStore â€” mÃ³dulo selecionado; persist localStorage)
â”œâ”€â”€ obra-shell-route.tsx     (casca: header + tabs; findObraModelo)
â”œâ”€â”€ pages/obra-eap.tsx       (EAP resumo; fonte isolada = FUTURO)
â”œâ”€â”€ pages/obra-visao-geral.tsx
â”œâ”€â”€ pages/obra-planejamento.tsx (consumer da Dashboard V1)
â””â”€â”€ pages/obra-modulo-placeholder.tsx
apps/app/src/react-app/domains/
â”œâ”€â”€ domain-registry.ts Â· domain-bootstrap.ts Â· domain-route.tsx Â· domain-sidebar-group.tsx
â”œâ”€â”€ navigation/{navigation-types,navigation-state,navigation-utils,sidebar-navigation}.ts(x)
â””â”€â”€ planejamento/*            (capacidade genÃ©rica â€” contratos)
```
Consulta ampla: `OBRA-MODELO-EAP-001`, `OBRA_MODELO_ID`, `findObraModelo`, `obraRoute`,
`caracterizacao`, `project|Project`, `obras`.

## 4. Estrutura atual encontrada (CONFIRMADO)
```text
DOMÃNIOS (seÃ§Ã£o da sidebar â€” dados: DomainDefinition.navigation)
â””â”€â”€ ENGENHARIA (domain, rota = home da 1Âª obra)
    â””â”€â”€ OBRAS (group, SEM rota prÃ³pria)
        â””â”€â”€ OBRA-MODELO-EAP-001 (entity, rota /dominios/engenharia/obras/{id})
            â””â”€â”€ mÃ³dulos (visao-geral/eap/frentes/planejamento/producao/rdo/ia)
```
- `obra-navigation.ts` monta a Ã¡rvore com UMA obra fixa (`OBRA_MODELO_ID`).
- Rota `/dominios/:domainId/obras/:obraId[/:modulo]` â€” `obra-routes.ts`.
- `domain.tsx#renderRoute` faz parse e delega a `ObraShellRoute(obraId, modulo)`.

## 5. Modelo atual de Obra (CONFIRMADO)
`obra-types.ts`:
```ts
type Obra = { id; nome; status: "PROPOSTA"; caracterizacao: ObraCaracterizacao; eap: ObraEapSummary }
type ObraCaracterizacao = { torres; lajes; apartamentosPorPavimento; subsolos; sistemaConstrutivo }
type ObraEapSummary = { status; total; raizes; pacotes; trabalhos }   // PROPOSTA Â· 10/24/47=81
```
Origem: `obra-data.ts` â€” `OBRA_MODELO` (objeto literal demo), `OBRAS_MODELO: Obra[] = [OBRA_MODELO]`,
`findObraModelo(id)` retorna da lista.

## 6. Origem dos dados (CONFIRMADO)
- **Hardcoded/demo** dentro do domÃ­nio (`obra-data.ts`, comentÃ¡rio: "obra-modelo (fonte Ãºnica de dados da casca)").
- **NÃƒO ENCONTRADO**: nenhuma outra origem (backend/API/banco) no clone para obras.

## 7. PersistÃªncia (CONFIRMADO)
- Obra: **sem persistÃªncia** â€” constante em memÃ³ria no bundle (demo).
- O que existe persistido Ã© **estado de UI**: `obra-store.ts` (zustand + localStorage,
  chave `openwork-obra-store`, apenas `selectedModule`).
- Contraste: **Workspaces** sÃ£o entidades do OpenWork persistidas pelo servidor local
  (config `authorizedRoots/workspaces` JSON + estado runtime SQLite) â€” conceito distinto.

## 8. IDs (CONFIRMADO)
- ID Ãºnico demo: constante `OBRA_MODELO_ID = "OBRA-MODELO-EAP-001"` (`obra-data.ts` L6).
- Rotas codificam via `encodeURIComponent` (`obra-routes.ts`).
- Estrutura Ã© adequada para mÃºltiplos IDs **desde que** a navegaÃ§Ã£o passe a ser dinÃ¢mica
  (hoje a Ã¡rvore declara apenas 1 obra). Sem colisÃ£o de rotas (id no path).

## 9. NavegaÃ§Ã£o (CONFIRMADO)
- `Obras` Ã© **nÃ³ agrupador (`group`) sem rota** â€” expande/recolhe (`obra-navigation.ts`).
- Obras NÃƒO sÃ£o filhos dinÃ¢micos: a Ã¡rvore Ã© estÃ¡tica com a obra demo.
- NÃ£o existe lista, seleÃ§Ã£o de obra na sidebar nem contexto de obra global; a "obra atual"
  vem **da URL** (`obraId` em `/obras/:obraId/â€¦`) resolvida por `findObraModelo`.
- `ObraShellRoute` mostra "Obra nÃ£o encontrada" se `findObraModelo` falhar.

## 10. RelaÃ§Ã£o Obra â†’ CaracterizaÃ§Ã£o (CONFIRMADO)
- `caracterizacao` Ã© **campo embutido** no objeto `Obra` (demo) â€” nÃ£o Ã© etapa separada e
  sÃ³ existe dentro de `domains/engenharia` (grep: sem ocorrÃªncias fora).
- NÃ£o estÃ¡ acoplada ao EAP em si, mas convive no mesmo objeto. NÃ£o hÃ¡ persistÃªncia.

## 11. RelaÃ§Ã£o Obra â†’ EAP (CONFIRMADO)
- `obra.eap` = **resumo embutido** (10/24/47 â†’ 81, PROPOSTA).
- NÃ³s individuais: **NÃƒO carregados** â€” fonte isolada em outro workspace (FUTURO;
  `obra-eap.tsx` L17-19). NÃ£o hÃ¡ tabela/ID por nÃ³ no clone (somente o resumo).

## 12. RelaÃ§Ã£o Obra â†’ Planejamento (CONFIRMADO)
- `obra-planejamento.tsx` (FASE 04.1) recebe `obra` por prop; usa somente
  `obra.nome` como contexto no `subtitle` do contrato; o dataset Ã© demo genÃ©rico.
- Planejamento **jÃ¡ estÃ¡ preparado para mÃºltiplas obras** (componente genÃ©rico
  `PlanningDashboard` recebe `PlanningDashboardData`); basta o adapter prover dados.
## 13. Fontes duplicadas encontradas
| Item | ClassificaÃ§Ã£o |
|---|---|
| `obra-data.ts` (`OBRA_MODELO`, `OBRAS_MODELO`) | **FONTE CANÃ”NICA** (demo) |
| `obra-navigation.ts` (Ã¡rvore com a obra) | **FONTE DERIVADA** da lista (estÃ¡tica) |
| `OBRA-MODELO-EAP-001` em `domain-registry.ts` L14, `domain.tsx` L14, `obra-eap.tsx` L17 | **LEGADO/COMENTÃRIO** (nÃ£o funcional) |
| Modelo externo no Obra Copilot/ARES | fora do clone (referÃªncia, nÃ£o duplicaÃ§Ã£o interna) |
| **DUPLICAÃ‡ÃƒO real**: **NÃƒO ENCONTRADA** dentro do clone | |

## 14. Problemas (CONFIRMADO)
1. `OBRAS_MODELO` existe como array, mas a navegaÃ§Ã£o/rotas assumem 1 obra fixa.
2. Sem experiÃªncia de lista/criaÃ§Ã£o/seleÃ§Ã£o de obras (sem UI de cadastro).
3. `obra-store` guarda `selectedModule` **global** (nÃ£o por obra) â€” risco futuro de
   lembrar mÃ³dulo de outra obra (baixo hoje porque a rota decide).
4. CaracterizaÃ§Ã£o/EAP/planejamento dependem hoje de um Ãºnico objeto demo; nÃ£o hÃ¡
   serviÃ§o/store por `obraId`.

## 15. Riscos (CONFIRMADO/FUTURO)
- Adicionar obras sÃ³ na Ã¡rvore sem fonte Ãºnica criaria duplicaÃ§Ã£o (Ã¡rvore Ã— dados).
- Criar "workspace" por obra seria um desvio conceitual (workspace â‰  obra).
- Persistir obra fora do domÃ­nio violaria Core+DomÃ­nio.
- `obra-store.selectedModule` global pode "vazar" entre obras (baixo hoje).
- Nenhuma rota reserva "lista de obras" (`/dominios/engenharia/obras` nÃ£o tem handler
  prÃ³prio hoje; `domain.tsx` sÃ³ trata `obras/:obraId`).

## 16. Arquitetura recomendada (RECOMENDAÃ‡ÃƒO)
```text
DOMÃNIO ENGENHARIA
â””â”€â”€ obras (repositÃ³rio/listagem do domÃ­nio â€” NOVA capacidade)
    â”œâ”€â”€ Nova obra        (aÃ§Ã£o de criaÃ§Ã£o â€” FASE futura de cadastro)
    â”œâ”€â”€ Obra A
    â””â”€â”€ Obra B
            â†“ contexto da obra (por obraId, vindo da URL/rota)
            â†“ mÃ³dulos (EAP, Planejamento, â€¦ recebem obra por prop/store por obraId)
```
- **Fonte Ãºnica**: uma lista de obras no domÃ­nio (evoluÃ§Ã£o de `OBRAS_MODELO`), com
  `findObraById`/`listObras` como serviÃ§o do domÃ­nio; a **Ã¡rvore de navegaÃ§Ã£o passa a ser
  montada a partir da lista** (data-driven â€” o Core jÃ¡ interpreta `NavigationNode[]`).
- A entidade Obra continua **no domÃ­nio Engenharia**; o Core nÃ£o conhece Obra.

## 17. Campos candidatos para cadastro (RECOMENDAÃ‡ÃƒO/HIPÃ“TESE)
Com base no modelo existente (`obra-types.ts`) e sem inventar evidÃªncia:
```text
Cadastro mÃ­nimo:  id (gerado) Â· nome Â· status
CaracterizaÃ§Ã£o:   separada, ETAPA posterior ao bÃ¡sico (campos de obra-data jÃ¡ existentes)
EAP/Planejamento: vÃ­nculos por obraId (futuro), sem embutir no cadastro
```
CaracterizaÃ§Ã£o **nÃ£o duplica** o modelo atual â€” migra para compor a obra (ou etapa).

## 18. EstratÃ©gia de persistÃªncia recomendada (RECOMENDAÃ‡ÃƒO â€” decisÃ£o em fase posterior)
- **Primeira versÃ£o**: declarativa no domÃ­nio (JSON/localStorage no padrÃ£o jÃ¡ usado:
  `obra-data.ts` + `zustand persist` como `obra-store`) â€” suficiente para lista + nova obra
  sem backend. **RECOMENDAÃ‡ÃƒO** para a fase imediata.
- EvoluÃ§Ã£o: persistir via **servidor OpenWork local + SQLite** (runtime jÃ¡ existe p/ workspaces)
  quando a obra precisar ser compartilhada/duradoura. Supabase/cloud: **decisÃ£o futura**;
  sem base hoje no clone.

## 19. Impacto no Core (RECOMENDAÃ‡ÃƒO)
- **Nenhum** conceito de Obra no Core. O Core jÃ¡ interpreta `NavigationNode[]`, rota
  genÃ©rica e `DomainDefinition`. Lista de obras = dado novo do domÃ­nio; a navegaÃ§Ã£o por
  "Obras â†’ [obras]" permanece renderizada pelo renderer genÃ©rico da sidebar.

## 20. Impacto no domÃ­nio Engenharia (RECOMENDAÃ‡ÃƒO)
- Evoluir `obra-data` â†’ repositÃ³rio (listar/criar/atualizar em memÃ³ria).
- `obra-navigation` passa a receber a lista (dados dinÃ¢micos) em vez de constante.
- Rotas continuam `/obras/:obraId/â€¦`; nova rota de listagem no domÃ­nio se necessÃ¡rio.
- `obra-store`: considerar escopo por `obraId` (estado de UI).

## 21. Itens fora de escopo (FUTURO)
Cadastro (formulÃ¡rio/modal), criaÃ§Ã£o de IDs, persistÃªncia real, listagem UI, seleÃ§Ã£o na
sidebar, migraÃ§Ã£o de EAP/planejamento por obraId, backend de obra, caracterizaÃ§Ã£o como
etapa, Workspace-obra. Nenhum destes foi implementado nesta fase.

## 22. PrÃ³ximo passo recomendado (FUTURO â€” nÃ£o executar nesta fase)
**FASE 04.2-B (gestÃ£o de obras V1)**: evoluir `obra-data` â†’ repositÃ³rio de obras do
domÃ­nio (lista demo com â‰¥2 obras, gerador de id simples, `findObraById`/`listObras`),
montar a navegaÃ§Ã£o `Obras â†’ [obras]` a partir da lista (data-driven), e uma rota/painel
de lista de obras â€” mantendo o Core intacto e sem persistir fora do domÃ­nio.

## EvidÃªncias-chave
- `obra-data.ts` L6/L8/L28/L30 (constante, objeto, array, find).
- `obra-navigation.ts` (Ã¡rvore com 1 obra fixa; group "Obras").
- `obra-types.ts` (modelo), `obra-store.ts` (persistÃªncia de UI).
- Greps: `OBRA-MODELO-EAP-001` fora de engenharia apenas em comentÃ¡rios;
  `caracterizacao`, `project|Project`, `obras/obraRoute` fora do domÃ­nio = **vazio**.



