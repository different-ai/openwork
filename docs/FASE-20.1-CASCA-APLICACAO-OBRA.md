# FASE 20.1 — CASCA NATIVA DA APLICAÇÃO DE OBRA (DOMÍNIO ENGENHARIA)

> **Data:** 2026-09-01 · **Tipo:** Implementação da casca (navegação nativa + rotas + entidade).
> **Escopo:** clone `OPENWORK-LAB\openwork`. **Nenhum módulo de negócio completo foi implementado.**

---

## 1. Objetivo

Criar a primeira casca funcional da aplicação de obra **dentro** do OpenWork (navegação
nativa, sem iframe/página externa), com a arquitetura corrigida:

```text
OPENWORK (Core — genérico)
├── SESSÕES (existente)
└── DOMÍNIOS (registro genérico)
    └── ENGENHARIA (domínio)
        └── OBRA-MODELO-EAP-001 (entidade do domínio)
            ├── Visão Geral · EAP · Frentes de Serviço · Planejamento · Produção · RDO · IA
```

## 2. Correção arquitetural aplicada (Core → Domínio → Entidade)

- **Não** foi criada `Obra` como entidade raiz do Core.
- Foi criado um **registro de domínios genérico** (`react-app/domains/domain-registry.ts`):
  o Core conhece apenas a interface `DomainDefinition` (id, label, homeRoute,
  renderSidebarItems, renderRoute). **Engenharia** registra-se por side-effect
  (`domain-bootstrap.ts`), e **Obra** pertence a Engenharia (`domains/engenharia/obra/`).
- **Não foi inventado um framework novo**: o padrão de registro por side-effect é o mesmo já
  usado pelo projeto em `settings/extension-registry.tsx` (Map global + register). A rota
  genérica `/dominios/:domainId/*` segue o padrão react-router 8 já existente em
  `shell/app-root.tsx`.

## 3. Arquitetura implementada

```text
apps/app/src/react-app/domains/
├── domain-registry.ts         registro genérico de domínios (Core não conhece Engenharia)
├── domain-bootstrap.ts        ponto único de registro (import side-effect dos domínios)
├── domain-route.tsx           rota genérica /dominios/:domainId/* (delega ao domínio)
├── domain-sidebar-group.tsx   seção "DOMÍNIOS" da sidebar (itera o registro)
└── engenharia/
    ├── domain.tsx             definição do domínio Engenharia (registerDomain)
    └── obra/
        ├── obra-types.ts      tipos (Obra, ObraModule, ObraEapSummary)
        ├── obra-data.ts       OBRA-MODELO-EAP-001 (fonte única de dados da casca)
        ├── obra-routes.ts     helpers de rota (/dominios/engenharia/obras/:id[/:modulo])
        ├── obra-store.ts      estado Zustand (módulo selecionado; persist localStorage)
        ├── obra-shell-route.tsx  casca da obra (header + navegação interna + página)
        ├── obra-sidebar-items.tsx  itens da sidebar (Engenharia → Obra → módulos)
        └── pages/
            ├── obra-visao-geral.tsx        (Visão Geral)
            ├── obra-eap.tsx                (EAP — resumo estrutural real)
            └── obra-modulo-placeholder.tsx (Frentes/Planejamento/Produção/RDO/IA)
```

## 4. Rotas criadas (nativas, react-router 8 — `shell/app-root.tsx`)

```text
/dominios/:domainId                      → DomainRoute (rota genérica do Core)
/dominios/:domainId/*                    → DomainRoute
/dominios/engenharia/obras/OBRA-MODELO-EAP-001                     → ObraShellRoute (Visão Geral)
/dominios/engenharia/obras/OBRA-MODELO-EAP-001/eap                 → EAP
/dominios/engenharia/obras/OBRA-MODELO-EAP-001/frentes             → placeholder
/dominios/engenharia/obras/OBRA-MODELO-EAP-001/planejamento        → placeholder
/dominios/engenharia/obras/OBRA-MODELO-EAP-001/producao            → placeholder
/dominios/engenharia/obras/OBRA-MODELO-EAP-001/rdo                 → placeholder
/dominios/engenharia/obras/OBRA-MODELO-EAP-001/ia                  → placeholder
/dominios/engenharia                         → redirect para a home do domínio (obra-modelo)
```

## 5. Entidade Obra — persistência

- **Obra** é entidade do domínio Engenharia (tipos em `obra-types.ts`; dados em
  `obra-data.ts`).
- **Persistência nesta fase:** a obra-modelo é a **fonte única declarativa** no clone
  (`obra-data.ts`) — dados estruturais reais e mínimos (id, nome, status PROPOSTA,
  caracterização 1 torre / 14 lajes / 1 apartamento por pavimento / 0 subsolos / concreto
  armado; EAP resumo 81 nós = 10/24/47, PROPOSTA). Nenhuma informação fictícia adicional.
- O estado de UI (módulo selecionado) usa o padrão do projeto: **Zustand + persist
  (localStorage)** (`obra-store.ts`), análogo a `session-management-store.ts`.
- **Persistência em servidor (SQLite via `createWorkspaceKvStore`/`runtime-db.ts`) é FUTURO**
  — a casca não cria tabelas nem rotas de servidor (evita persistência especulativa,
  conforme regra da FASE 20.1 §11).

## 6. Sidebar — integração

- `app-sidebar.tsx` (modificado): a seção genérica **DOMÍNIOS** foi adicionada ao conteúdo
  (`<DomainsSidebarGroup />`), logo acima das sessões/workspaces existentes.
- `domain-sidebar-group.tsx` itera o registro de domínios e renderiza os itens de cada um.
- `obra-sidebar-items.tsx` renderiza a árvore: **Engenharia** (expansível, padrão Base UI
  `Collapsible` com `render`) → **OBRA-MODELO-EAP-001** → os 7 módulos
  (`SidebarMenuSub`), com navegação real via `useNavigate`.
- **Nenhuma funcionalidade existente foi removida** (workspaces, sessões, pins, grupos,
  settings, extensions continuam intactos — regressão validada).

## 7. EAP — como foi tratada

- **Resumo estrutural real preservado:** 81 nós = 10 raízes (nível 1) + 24 pacotes (nível 2)
  + 47 trabalhos (nível 3), status **PROPOSTA** — exibidos na página EAP **sem alterar,
  aprovar, recalcular ou reinterpretar**.
- **Nós individuais (81): NÃO VERIFICADO** — a árvore real da OBRA-MODELO-EAP-001 vive em
  fonte isolada (outro workspace); a regra de isolamento da FASE 20.1 proíbe importar de
  fora. A página EAP deixa explícito que o carregamento da fonte real é **FUTURO**.
- **Fonte única:** a EAP não é duplicada (nenhum banco/JSON/frontend replicado); a casca
  guarda apenas o resumo estrutural.

## 8. Placeholders

Frentes de Serviço, Planejamento, Produção, RDO e IA são **páginas placeholders funcionais**
(`obra-modulo-placeholder.tsx`) com o aviso de que serão vinculadas aos elementos da EAP
(`elemento_eap_id`) em fases futuras. Nenhuma lógica de negócio foi implementada.

## 9. Testes executados

| Teste | Resultado |
|---|---|
| `bun test tests/engenharia-obra-domain.test.ts` (entidade, rotas, módulos) | ✅ **8 PASS / 0 FAIL** (28 expect) |
| `bun test tests/workspace-routes.test.ts` (regressão do fluxo existente) | ✅ **18 PASS / 0 FAIL** (51 expect) |
| `tsc -p tsconfig.json --noEmit` (typecheck do app) | ✅ **EXIT 0** |
| Build de produção (`vite build`) | **NÃO VERIFICADO** — não executado nesta fase (validado por typecheck + testes); recomenda-se rodar antes de release |

## 10. Arquivos

**Criados (14):**
```
apps/app/src/react-app/domains/domain-registry.ts
apps/app/src/react-app/domains/domain-bootstrap.ts
apps/app/src/react-app/domains/domain-route.tsx
apps/app/src/react-app/domains/domain-sidebar-group.tsx
apps/app/src/react-app/domains/engenharia/domain.tsx
apps/app/src/react-app/domains/engenharia/obra/obra-types.ts
apps/app/src/react-app/domains/engenharia/obra/obra-data.ts
apps/app/src/react-app/domains/engenharia/obra/obra-routes.ts
apps/app/src/react-app/domains/engenharia/obra/obra-store.ts
apps/app/src/react-app/domains/engenharia/obra/obra-shell-route.tsx
apps/app/src/react-app/domains/engenharia/obra/obra-sidebar-items.tsx
apps/app/src/react-app/domains/engenharia/obra/pages/obra-visao-geral.tsx
apps/app/src/react-app/domains/engenharia/obra/pages/obra-eap.tsx
apps/app/src/react-app/domains/engenharia/obra/pages/obra-modulo-placeholder.tsx
apps/app/tests/engenharia-obra-domain.test.ts
docs/FASE-20.1-CASCA-APLICACAO-OBRA.md   (este relatório)
```

**Modificados (2):**
```
apps/app/src/react-app/shell/app-root.tsx        (rotas /dominios/:domainId/* + bootstrap)
apps/app/src/react-app/domains/session/sidebar/app-sidebar.tsx   (seção DOMÍNIOS)
```

## 11. Limitações

- **EAP de 81 nós:** apenas o resumo estrutural (10/24/47, PROPOSTA) é exibido; os nós
  individuais não foram importados (isolamento) → carregamento real **FUTURO**.
- **Persistência:** obra-modelo declarativa (fonte única no frontend); servidor/SQLite
  **FUTURO** (a entidade e os módulos serão persistidos quando os módulos de negócio forem
  implementados, seguindo `createWorkspaceKvStore`/`runtime-db.ts`).
- **Verificação visual interativa** (abrir o app e clicar na sidebar): **NÃO VERIFICADO**
  nesta sessão — a validação foi por typecheck + testes + build não executado. Para
  confirmação visual, rodar `pnpm --filter @openwork/app dev` e navegar até
  `/dominios/engenharia/obras/OBRA-MODELO-EAP-001`.
- **Extensibilidade futura:** adicionar novo domínio (Administração, Medicina, Direito)
  requer apenas registrar em `domain-bootstrap.ts` + criar a pasta do domínio — **sem
  alterar o Core**.

## 12. Veredito

```text
ARQUITETURA:   Core → Domínio → Entidade (Obra NÃO é entidade raiz do Core)  ✅
CASCA:         IMPLEMENTADA (sidebar nativa + rotas nativas + páginas)         ✅
ENTIDADE:      OBRA-MODELO-EAP-001 (status PROPOSTA)                           ✅
ROTAS:         /dominios/engenharia/obras/OBRA-MODELO-EAP-001[/{modulo}]      ✅
SIDEBAR:       DOMÍNIOS → Engenharia → Obra → 7 módulos                        ✅
EAP:           resumo estrutural real (81 = 10/24/47, PROPOSTA)                ✅ (nós: FUTURO)
PLACEHOLDERS:  Frentes/Planejamento/Produção/RDO/IA                            ✅
PERSISTÊNCIA:  declarativa (frontend); servidor/SQLite = FUTURO                ✅
TESTES:        8/0 (obra) + 18/0 (regressão) + typecheck 0                     ✅
CORE:          não conhece Engenharia/Obra (registro genérico)                 ✅
```

> **A casca está pronta para validação visual.** As próximas fases construirão os módulos de
> Engenharia sobre esta base, vinculando Frentes/Planejamento/Produção/RDO/IA aos elementos
> da EAP (`elemento_eap_id`), sem alterar o Core.

---

*Relatório gerado em 2026-09-01 · FASE 20.1 · casca nativa do domínio Engenharia ·
Core → Domínio → Entidade · nenhum commit realizado.*