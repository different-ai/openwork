# FASE 20.0 — AUDITORIA ARQUITETURAL DO CLONE OPENWORK (CRIAÇÃO DA INTERFACE DE OBRA)

> **Data:** 2026-09-01 · **Tipo:** Auditoria READ-ONLY (INSPEÇÃO → MAPEAMENTO → EVIDÊNCIA → ARQUITETURA PROPOSTA).
> **Escopo:** clone `OPENWORK-LAB\openwork` (tag v0.18.40). Nenhum arquivo de código alterado;
> somente este documento foi criado.
> **Objetivo:** responder **onde e como** criar a entidade `Obra` com navegação própria
> (`/obra/:id`, `/obra/:id/eap|frentes|planejamento|producao|rdo|ia`), com EAP como espinha
> dorsal.

---

## 1. Stack (evidência)

| Camada | Tecnologia | Evidência |
|---|---|---|
| Monorepo | **pnpm@11.4.0 + Turbo 2.10.7** | `package.json` (`packageManager`), `pnpm-workspace.yaml`, `turbo` devDep |
| Frontend | **React 19.2.8 + TypeScript 5.9** | `pnpm-workspace.yaml` catalog; `apps/app/package.json` |
| Build frontend | **Vite 6.4.3 + @vitejs/plugin-react + Tailwind 4 + shadcn/ui** | `apps/app/package.json`; `apps/app/tsconfig.json` |
| Roteamento | **react-router 8.3.0** (`<Routes>` declarativos) | `apps/app/src/react-app/shell/app-root.tsx` |
| Estado | **Zustand 5** (stores + `persist` localStorage) + **TanStack Query 5** + Context | `session-management-store.ts`, `query-client.ts` |
| UI | `@/components/ui/*` (shadcn) + `@/packages/ui` + `lucide-react` + `@base-ui/react` | `app-sidebar.tsx`, `apps/app/package.json` |
| Backend | **Node/Bun + SQLite (`node:sqlite`/`bun:sqlite`) + drizzle-orm** | `apps/server/src/runtime-db.ts`, `workspace-kv-store.ts` |
| Server HTTP | Router próprio (`routes/registry.ts` — `addRoute`/`matchRoute` com `:param` → regex) | `apps/server/src/routes/*.ts` |
| Desktop | **Electron** (`apps/desktop`) + sidecars (opencode) | `apps/desktop`, `engine-instances.json` |
| Autenticação | Tokens (`TokenService`), **Den/Better-Auth** (enterprise `ee/`) | `apps/server/src/tokens.ts`, `ee/apps/den-api` |
| IA/engine | **OpenCode SDK (`@opencode-ai/sdk` 1.18.15)** gerenciado via `EnginePool` | `apps/server/src/engine-pool.ts`, `apps/app/src/app/lib/opencode.ts` |
| Plugins/extensão | Plugins + Skills + Commands + MCP gerenciados pelo server | `apps/server/src/plugins.ts`, `skills.ts`, `commands.ts`, `mcp.ts` |

## 2. Arquitetura atual

```
apps/app (React SPA, Vite) ── HTTP ──▶ apps/server (Node/Bun, router próprio)
   ├─ react-app/shell/        (app-root.tsx, session-route, settings-route, workspace-routes)
   ├─ react-app/domains/      (session, workspace, settings, dashboard, connections, cloud, automations, onboarding)
   ├─ react-app/kernel/       (server-provider, local-provider, global-sdk-provider, platform)
   ├─ react-app/infra/        (query-client, workspace-server-client)
   └─ app/lib/                (opencode.ts, openwork-server.ts, workspace-endpoint.ts, desktop.ts)
apps/desktop (Electron) ── IPC ──▶ apps/server (embedded)
apps/server ── gera/gerencia engines OpenCode (EnginePool) + config OpenCode por workspace
```

- **Separação Core/Domains:** o app já separa `shell` (estrutura) de `domains` (negócio) —
  padrão que favorece novos módulos.
- **Client SDK:** o app consome o OpenCode via `@opencode-ai/sdk` e o OpenWork via
  `OpenworkServerClient` (`app/lib/openwork-server.ts`), com endpoint resolvido por
  workspace (`app/lib/workspace-endpoint.ts`).

## 3. Sidebar (evidência)

```
Arquivo:      apps/app/src/react-app/domains/session/sidebar/app-sidebar.tsx
              + app-sidebar-provider.tsx (SidebarContext)
              + sidebar-lanes.tsx / sidebar-lane-metrics.tsx (layout de rails/glyphs)
              + session-management-store.ts (estado Zustand)
Componente:   shadcn <Sidebar> (de @/components/ui/sidebar) com SidebarGroup/Menu/
              Collapsible/ContextMenu; ícones lucide-react
Estado:       Zustand `useSessionManagementStore` (persist localStorage): ordem,
              pins, groups, collapsed; `SidebarContextValue` (app-sidebar-provider):
              selectedWorkspaceId, selectedSessionId, expandedWorkspaceIds, callbacks
Dados:        `useWorkspaceGroups(workspaceId)` (store) → WorkspaceGroupState
              (groups/assignments); sessões via Session SDK (listRouteSessions)
Rota/ação:    onSelectWorkspace(id), onOpenSession(ws, session) → navega via
              react-router (session-route); cria/renomeia/arquiva/apaga sessões
Persistência: localStorage (Zustand persist) + estado de sessões no server (OpenCode)
```

**Ponto crítico:** a sidebar é **hardcoded para workspaces/sessões** (a estrutura de
"Obras" não existe). Adicionar uma seção "OBRAS" exigirá estender `app-sidebar.tsx` ou —
melhor — **introduzir uma fonte de dados de navegação** (ver seção 11).

## 4. Workspace

```
Modelo:   WorkspaceInfo = WorkspaceWire (apps/app/src/app/lib/desktop-types.ts)
          id, name, path, displayName, workspaceType (local|remote), baseUrl,
          openworkHostUrl/Token, openworkWorkspaceId ...
Store:    openwork_workspace_configs no runtime.sqlite (server) + authorizedRoots
Criação:  POST /workspaces/local|remote (routes/workspaces.ts) → diretório + seed
          (workspace-init.ts: ensureWorkspaceFiles, opencode.jsonc)
Abertura: app/lib/workspace-endpoint.ts resolve endpoint do workspace
          (baseUrl/token/workspaceId + mount /workspace/:id)
Troca:    session-route.tsx (workspaceSetSelected, resolveWorkspaceListSelectedId)
Sessões:  WorkspaceSessionGroup { workspace, sessions, status } (app/types.ts)
Relacionamento: sessões pertencem a workspaces; rota /workspace/:workspaceId/session
```

> **Viabilidade da entidade Obra:** SIM — há dois caminhos técnicos: (a) **Obra como
> workspace** (herda infraestrutura pronta de navegação/rota/endpoint, mas acopla a
> conceitos de sessão/IA do OpenWork); (b) **Obra como entidade própria** (novo domínio +
> rotas + tabelas) — recomendado, para manter a separação Core/Domain e não contaminar o
> conceito de workspace.

## 5. Rotas e páginas

**Frontend (react-router 8) — `shell/app-root.tsx` (`<Routes>`):**
```
/ → redirect /session
/session, /session/:sessionId                     (legacy)
/workspace/:workspaceId/session[/:sessionId]      (sessão por workspace)
/automations, /dashboard
/workspace/:workspaceId/extensions/*, /extensions/*
/workspace/:workspaceId/settings/*, /settings/*
```
- Helpers: `shell/workspace-routes.ts` (`workspaceSessionRoute`, `workspaceSettingsRoute`,
  `workspaceExtensionsRoute`, `legacySessionRoute`).
- Layout: `shell/app-root.tsx` monta providers (DenAuth, ShellConfig, AppMenu,
  OpenworkControl) e `<Routes>`.

**Backend (router próprio) — `routes/*.ts` (`addRoute`):**
```
core:  /health, /w/:id/status, /w/:id/capabilities, /w/:id/workspaces, /status, /whoami,
       /capabilities, /workspaces, /tokens, /env/...
files: /workspace/:id/inbox|artifacts|files/content|stat|raw|sessions
ops:   /workspace/:id/events, /workspace/:id/engine/reload, /approvals
groups: /workspace/:id/session-groups[...]
ws:    /workspaces/local, /workspaces/remote, /workspaces/:id/display-name|activate
cloud: /workspace/:id/mcp/openwork-cloud/...
```

> **Conclusão para rotas futuras:** é **totalmente viável** adicionar
> `/obra/:id[/eap|frentes|planejamento|producao|rdo|ia]` no frontend (novas `<Route>` no
> `app-root.tsx`) e `/workspace/:id/obra/...` ou `/obra/...` no server (`registerObraRoutes`
> seguindo `routes/workspaces.ts`).

## 6. Persistência

| Camada | Mecanismo | Arquivos |
|---|---|---|
| Server (estado) | **SQLite** `runtime.sqlite` via `node:sqlite`/`bun:sqlite` + **drizzle-orm** | `apps/server/src/runtime-db.ts` (path: `openworkConfigDir()/runtime.sqlite`), `workspace-kv-store.ts`, `runtime-opencode-config-store.ts`, `connect-state.ts` |
| Workspaces | `openwork_workspace_configs` (SQLite) + diretório no disco + `opencode.jsonc`/`.opencode/` no workspace | `openwork-workspace-config-store.ts`, `workspace-init.ts` |
| Sessões (IA) | OpenCode engine (arquivos/transcripts; server-side `session.time.archived`) | `apps/server/src/file-sessions.ts`, SDK |
| App (UI) | **localStorage** via Zustand persist (ordem/pins/grupos/colapsados) | `session-management-store.ts`, `ui-state-store.ts` |
| Config OpenCode | `opencode.jsonc` por workspace + config global + `runtime-opencode-config.json` | `apps/server/src/jsonc.ts`, `runtime-opencode-config-store.ts` |

> **Futura entidade `Obra`:** recomendado persistir em **SQLite** (novas tabelas
> `obras`, `obra_eap`, `obra_frentes`, ...) via novas rotas no server — seguindo o padrão
> `workspace-kv-store.ts`/`runtime-db.ts` com drizzle. O módulo Engenharia (Workspace
> oficial) já tem a lógica de domínio pronta (`_store.mjs`/`_eap_models.mjs`) que poderá ser
> **reimplementada como rotas server** (não copiada como duplicata).

## 7. Extensibilidade

- **Plugins:** `apps/server/src/plugins.ts` — lista plugins por config (`opencode.jsonc`
  `plugin: [...]`) + diretório de plugins do projeto (`projectPluginsDir`); adiciona/remove
  via `addPlugin/removePlugin`. Suporta `file:`/`http:`/`git:`/npm specs.
- **Skills:** `apps/server/src/skills.ts` (`listSkills/upsertSkill/deleteSkill`) — skills
  são arquivos `SKILL.md` no workspace (`projectSkillsDir`) + globais.
- **Commands:** `apps/server/src/commands.ts` (`listCommands/upsertCommand/repairCommands`).
- **MCP:** `apps/server/src/mcp.ts`, `local-managed-mcp.ts`, `mcp-app-host.ts` — servidores
  MCP por workspace e apps MCP.
- **UI extensions:** rotas `/extensions/*` no app (Settings → Extensions; MCP/Plugins).
- **OpenCode config:** `opencode.jsonc` por workspace (permissions, agents, skills,
  commands, plugins) — o mecanismo nativo que o OpenWork usa.

> **Conclusão:** o clone **já tem mecanismos de extensão** (plugins/skills/commands/mcp),
> porém **não existe um "domain registry" no frontend** que permita plugar um módulo de UI
> novo (ex.: Obra) sem editar `app-root.tsx` e `app-sidebar.tsx`. Esse é o principal ponto a
> criar/refatorar.

## 8. Fluxo atual (nomes reais)

```
usuário
  → app-sidebar.tsx (shadcn Sidebar, ícones lucide)
  → session-management-store.ts (Zustand; seleção)
  → session-route.tsx (useNavigate; react-router)
  → app-root.tsx (<Routes>) → <SessionRoute>
  → WorkspaceProvider (shell/workspace-provider.ts) [client, workspaceId, selectedWorkspaceRoot]
  → workspace-endpoint.ts (resolve baseUrl/token/mount /workspace/:id)
  → apps/server (routes: core/files/operations/session-groups)
  → EnginePool → engine OpenCode (sdk) → dados (SQLite runtime.sqlite + transcripts)
  → session-surface.tsx / session-page.tsx (renderização)
```

## 9. Pontos de extensão (onde alterar para a Obra)

| O quê | Onde (arquivo real) |
|---|---|
| Nova rota frontend | `apps/app/src/react-app/shell/app-root.tsx` (novas `<Route path="/obra/...">`) |
| Helper de rotas | `apps/app/src/react-app/shell/workspace-routes.ts` (novos helpers `obraRoute`) |
| Nova página/layout | novo `apps/app/src/react-app/domains/obra/` (seguindo padrão `domains/session`) |
| Nova seção na sidebar | `domains/session/sidebar/app-sidebar.tsx` + `app-sidebar-provider.tsx` (fonte de dados de navegação) |
| Estado | novo store Zustand `domains/obra/obra-store.ts` (padrão `session-management-store.ts`) |
| API client | `apps/app/src/app/lib/` (novo `obra-client.ts` + `openwork-server.ts` client) |
| Rotas server | novo `apps/server/src/routes/obras.ts` + `registerObraRoutes` em `server.ts` |
| Persistência | novas tabelas via `apps/server/src/runtime-db.ts`/`workspace-kv-store.ts` (drizzle) |
| Domínio determinístico | reutilizar a lógica do módulo Engenharia (EAP `_store`/`_eap_models`) como serviço server |

## 10. Riscos

1. **Sidebar monolítica:** `app-sidebar.tsx` concentra toda a navegação (workspaces +
   sessões + ações). Adicionar "Obras" inline aumenta complexidade — mitigar com **fonte de
   dados de navegação** (registry).
2. **Acoplar Obra ao workspace:** se a Obra for implementada "por dentro" de workspace,
   herda sessões/IA/conceitos do OpenWork e mistura domínio com plataforma (viola a
   separação Core/Domain do nosso contrato).
3. **Duplicar lógica de EAP:** não copiar `_store.mjs`/`_eap_models.mjs` para o app — deve
   virar **serviço server** (rotas + SQLite) reutilizando as regras existentes.
4. **Estado fragmentado:** app usa Zustand + Query + Context — novos módulos devem seguir um
   padrão único (Zustand p/ UI, Query p/ server).
5. **Router server customizado:** `addRoute`/`matchRoute` é simples e sem middlewares —
   validação/erros precisam ser consistentes nos novos `routes/obras.ts`.
6. **EAP como espinha dorsal:** todos os módulos futuros (Frentes, Planejamento, Produção,
   RDO, IA) devem referenciar **`elemento_eap_id`** (não duplicar a árvore) — risco de
   desvio se não for estabelecido como contrato de tabelas desde o início.

## 11. Arquitetura futura proposta (referência — NÃO implementar nesta fase)

```text
FRONTEND (apps/app)
├─ shell/app-root.tsx            + rotas /obra/:id e /obra/:id/{eap,frentes,planejamento,producao,rdo,ia}
├─ react-app/domains/obra/       (novo domain: obra-shell.tsx, obra-store.ts (Zustand),
│                                 pages: visao-geral, eap, frentes, planejamento, producao, rdo, ia)
├─ app/lib/obra-client.ts        (client → server /obra...)
└─ app-sidebar.tsx               (seção "OBRAS" alimentada por fonte de dados — registry)

BACKEND (apps/server)
├─ routes/obras.ts               (registerObraRoutes: CRUD obra + submódulos)
├─ runtime-db.ts                 (novas tabelas drizzle: obras, obra_eap, obra_frentes,
│                                 obra_planejamento, obra_producao, obra_rdo)
└─ services/obra-eap.ts          (reimplementa as regras de EAP do módulo Engenharia —
                                  validação de árvore, ciclos, unicidade — como serviço)

DADOS (relacionamento — EAP como espinha dorsal)
obras (obra_id) ─ 1:N ─ obra_eap (eap_id) ─ 1:N ─ obra_eap_elemento (elemento_eap_id)
                                  ▲        ▲        ▲        ▲
                            frentes   planej.   producao   rdo   (referenciam elemento_eap_id)
```

**Princípios:**
- **Baixo acoplamento:** novo domain `obra/` no app; rotas e tabelas próprias; nenhuma
  alteração no fluxo de sessões/workspaces existente.
- **Reutilização:** UI via `@/components/ui/*` (shadcn); layout reaproveita `Sidebar`;
  regras de EAP reimplementadas como serviço (sem duplicação).
- **Separação Core/Domain:** o Core continua sendo plataforma (workspaces, sessões, IA); a
  Obra é **entidade de domínio** na camada `domains/obra` + `routes/obras.ts`.
- **Multi-domínio futuro:** o mesmo padrão serve para outros domínios além de Engenharia
  (basta criar `domains/<dominio>` + `routes/<dominio>.ts` + tabelas).
- **Preservação do existente:** nada do fluxo atual (sidebar de workspaces, sessões,
  settings, extensions) é removido; "Obras" é **aditivo**.

## 12. Arquivos relevantes (mapa de alteração futura)

| Função | Arquivo |
|---|---|
| Rotas frontend | `apps/app/src/react-app/shell/app-root.tsx` |
| Helpers de rota | `apps/app/src/react-app/shell/workspace-routes.ts` |
| Sidebar | `apps/app/src/react-app/domains/session/sidebar/app-sidebar.tsx` · `app-sidebar-provider.tsx` |
| Estado sidebar | `apps/app/src/react-app/domains/session/sidebar/session-management-store.ts` |
| Workspace provider | `apps/app/src/react-app/shell/workspace-provider.ts` |
| Endpoint/API | `apps/app/src/app/lib/workspace-endpoint.ts` · `openwork-server.ts` |
| Server rotas | `apps/server/src/routes/workspaces.ts` (padrão) · `server.ts` (registro) |
| Persistência | `apps/server/src/runtime-db.ts` · `workspace-kv-store.ts` |
| Skills/Commands/Plugins/MCP | `apps/server/src/skills.ts` · `commands.ts` · `plugins.ts` · `mcp.ts` |
| Modelo de sessões | `apps/app/src/app/types.ts` (WorkspaceSessionGroup, Client, SettingsTab) |
| Lógica de domínio EAP (fonte) | Módulo Engenharia (Workspace oficial) — `_store.mjs`/`_eap_models.mjs` |

## 13. Evidências

1. `pnpm-workspace.yaml` — React 19.2.8 catalog; pnpm 11.4; packages `apps/*`, `packages/*`.
2. `apps/app/package.json` — react-router 8.3.0, zustand 5.0.12, react-query, vite 6.4.3,
   tailwind 4, shadcn.
3. `apps/app/src/react-app/shell/app-root.tsx` — `<Routes>` declarativas (session/settings/
   extensions/dashboard/automations/workspace).
4. `apps/app/src/react-app/shell/workspace-routes.ts` — helpers de rota por workspace.
5. `apps/app/src/react-app/domains/session/sidebar/app-sidebar.tsx` + `app-sidebar-provider.tsx`
   — shadcn Sidebar; `SidebarContextValue` com callbacks de seleção.
6. `session-management-store.ts` — Zustand + persist localStorage (`useWorkspaceGroups`).
7. `apps/server/src/routes/registry.ts` — router próprio (`addRoute`/`matchRoute`).
8. `apps/server/src/routes/workspaces.ts` + `core.ts` + `files.ts` + `session-groups.ts` —
   conjunto real de rotas `/workspace/:id/...`.
9. `apps/server/src/runtime-db.ts` + `workspace-kv-store.ts` — SQLite `runtime.sqlite`
   (node:sqlite/bun:sqlite + drizzle).
10. `apps/server/src/plugins.ts` · `skills.ts` · `commands.ts` · `mcp.ts` — extensibilidade.

## 14. Conclusão

### ARQUITETURA ADEQUADA COM REFATORAÇÃO

**Por quê (evidência):**
- O clone tem **base sólida para evolução**: React 19 + react-router 8 + Zustand + Query;
  separação `shell/`×`domains/`; server com router registrável; SQLite/drizzle; mecanismos
  de extensão (plugins/skills/commands/mcp). Isso sustenta a criação da entidade `Obra`
  **sem** reescrever a plataforma.
- **Refatoração necessária (mínima e localizada):**
  1. **Introduzir um "domain registry" de navegação** no app (fonte de dados da sidebar +
     registro de rotas) para não crescer `app-sidebar.tsx`/`app-root.tsx` de forma
     monolítica a cada novo módulo.
  2. **Criar o domain `obra/`** (rotas + páginas + store + client) como bloco **aditivo**,
     sem tocar o fluxo de workspaces/sessões.
  3. **Criar rotas server `obras.ts` + tabelas SQLite** seguindo o padrão existente.
  4. **Reimplementar as regras de EAP como serviço server** (reutilizando a lógica do módulo
     Engenharia), mantendo a **EAP como espinha dorsal**: todos os módulos futuros
     referenciam `elemento_eap_id`.

**Recomendação de sequência futura (após decisão humana):**
```
1. Domain registry (navegação) no app
2. Domain obra/ (rotas + store + páginas básicas + sidebar "OBRAS")
3. Rotas server obras.ts + tabelas (obras, obra_eap, obra_eap_elemento)
4. Serviço EAP (validação determinística) reutilizando regras do módulo
5. Módulos referenciais: frentes/planejamento/producao/rdo/ia apontando para elemento_eap_id
```

> **Se quisermos transformar este clone no sistema de gestão de obras:** os arquivos a
> alterar são os da seção 12; o padrão a seguir é o da seção 11; e a condição estrutural é
> criar o **domain registry** + **domain `obra/`** como bloco aditivo, sem duplicar EAP.

---

*Relatório gerado em 2026-09-01 · FASE 20.0 · auditoria somente leitura · único arquivo
criado: este documento em `docs/` · nenhum código/arquitetura alterado.*