# FASE 04.2-C — AUDITORIA DA HIERARQUIA VISUAL DA SIDEBAR (read-only)

> **Data:** 2026-01-09 · **Tipo:** auditoria somente leitura — nenhum código alterado.

## 1. Objetivo
Determinar se a sidebar representa corretamente a arquitetura
`Core → Domínio → Entidade → Módulo` (DOMÍNIOS → ENGENHARIA → OBRAS → OBRA →
MÓDULOS) e se a estrutura está pronta para Engenharia hoje e para
Administração/Direito amanhã, sem contaminar o Core.

## 2. Contexto
FASE 04.2-B implementou gestão dinâmica de obras (repositório, multi-obra,
`+ Nova obra`, `obraId` por URL, persistência local). A validação visual da
sidebar gerou a percepção de possível "perda de nível" entre DOMÍNIO → OBRAS →
OBRA.

## 3. Estado anterior
- `DomainDefinition.navigation` como `NavigationNode[]` por domínio.
- Renderer genérico recursivo (`SidebarNavigationList`).
- Seção "DOMÍNIOS" inserida na sidebar da SESSÃO (`app-sidebar.tsx` L1233).

## 4. Arquivos auditados
`domain-registry.ts` · `domain-sidebar-group.tsx` · `domain-route.tsx` ·
`domain-back-button.tsx` · `navigation/{navigation-types,navigation-state,
navigation-utils,sidebar-navigation}.ts(x)` ·
`engenharia/domain.tsx` · `engenharia/obra/{obra-navigation,obra-routes,
obra-shell-route,obra-store,obra-repository}.ts` ·
`session/sidebar/app-sidebar.tsx` · testes listados na §12.
Comandos executados (inspeção somente leitura):
`Get-Content`, `Select-String` (busca de termos), contagem/leitura de arquivos.

## 5. Árvore REAL produzida em runtime [CONFIRMADO]
```text
(app-sidebar · seção "DOMÍNIOS" — rótulo de seção, não nó)
└─ nó raiz: Engenharia        (type domain, id domain:engenharia, rota=/dominios/engenharia/obras)
   └─ nó: Obras               (type group, sem rota própria)
      ├─ + Nova obra          (type entity, rota /dominios/engenharia/obras/nova)
      ├─ OBRA-MODELO-EAP-001  (type entity, rota /dominios/engenharia/obras/OBRA-MODELO-EAP-001)
      │   └─ módulos (Visão Geral · EAP · Frentes · Planejamento · Produção · RDO · IA)
      ├─ Obra Demonstrativa 01 (entity + módulos)
      └─ Obra Demonstrativa 02 (entity + módulos)
```
Fonte: `obra-navigation.ts` (L39-65) + `DomainDefinition.navigation` consumida por
`domain-sidebar-group.tsx` (L29-33 → `SidebarNavigationList depth=0`).

### Respostas da §2
- **A.** Nó "DOMÍNIOS": [CONFIRMADO] **não existe como nó de dados** — é rótulo de seção
  (`domain-sidebar-group.tsx` L26 `SIDEBAR_SECTION_LABEL`), agrupamento conceitual.
- **B.** Nó "Engenharia": [CONFIRMADO] raiz do domínio (`obra-navigation.ts` L51-54).
- **C.** Nó "Obras": [CONFIRMADO] `group` filho de Engenharia (L56-61), sem rota.
- **D.** Obras são filhas de `OBRAS` (group), não de Engenharia [CONFIRMADO].
- **E.** Módulos são filhos da entidade Obra (`obraNode.children`, L25-33) [CONFIRMADO].
- **F.** `+ Nova obra` é um **`NavigationNode` real** (`type entity`, com rota própria,
  id `domain:engenharia:obras:nova`) — filho do group Obras, antes das obras [CONFIRMADO].

## 6. Árvore arquitetural desejada (referência do prompt)
Mesma cadeia, com módulos adicionais (Caracterização, Serviços, Orçamento, Recursos,
Medição, Controle, Indicadores…) por Obra — **FUTURO** (hoje o modelo tem 7 módulos).

## 7. Arquitetura (dados vs. render) [CONFIRMADO]
- `NavigationNode[]` = dados; `SidebarNavigationList` = renderer recursivo.
- Sem "flatten": a árvore é percorrida nó a nó (`sidebar-navigation.tsx` L96-100);
  filhos só existem com o pai expandido (estado `navigation-state`).
- Renderização genérica: nenhuma dependência de tipo específico para decidir a
  hierarquia — `type` é dado informativo (usado em data attrs/acentos), não roteia
  lógica de domínio.
## 8. Routing [CONFIRMADO]
```text
/dominios/:domainId                    → DomainRoute (Core)
/dominios/engenharia/obras             → lista de obras (ObraListaPage)
/dominios/engenharia/obras/nova        → criação (+ Nova obra)
/dominios/engenharia/obras/:obraId     → ObraShellRoute (obra, módulo default)
/dominios/engenharia/obras/:obraId/:modulo → ObraShellRoute (módulo)
```
Fonte: `domain.tsx#renderRoute`, `obra-routes.ts` (helpers). `obraId` sempre presente
nas rotas de obra; a URL é a fonte do contexto (`ObraShellRoute` → `findObraById`).

## 9. Contexto [CONFIRMADO]
- Domínio: `domainId` da URL; obra: `obraId` da URL; módulo: segmento opcional.
- `obra-store.ts` guarda apenas `selectedModules[obraId]` (lembrança de UI); não decide
  contexto. `navigation-state.ts` guarda expansão por `node.id` (ids incluem `obra.id`
  → expansão independente por obra). Nenhum estado global substitui o `obraId` da URL.

## 10. Renderização [CONFIRMADO]
- Todos os níveis são renderizados (recursão); nenhum nível é descartado.
- Indentação por profundidade: `ps-3` na linha + `ms-2.5 border-l` no container de
  filhos (`sidebar-navigation.tsx` L71, L97-99).
- Nós com filhos: clique alterna expansão (L61-64). Nós folha com rota: navegam.
- Nenhuma lógica específica para Engenharia/Obra no renderer/Core (busca por
  termos só encontra comentários de design — §evidências).
- A sidebar DOMÍNIOS é montada SOMENTE na superfície de **sessão** (`app-sidebar.tsx`
  L1233 dentro do conteúdo da sidebar da sessão); as rotas `/dominios/*` são
  renderizadas pelo `DomainRoute` **fora** dessa sidebar.

## 11. Multi-obra [CONFIRMADO]
- Cada obra tem `entity` própria com módulos próprios (mesma fonte `ObraRepository`).
- `selectedModules[obraId]`, rota por `obraId` e ids de expansão com `obra.id`
  → obras A/B não compartilham módulo/expansão/contexto indevidamente.

## 12. Testes existentes (cobertura real) [CONFIRMADO]
- `engenharia-navigation.test.ts`: árvore de DADOS (raiz/Obras/+ Nova/multi-obra/rotas),
  helpers (back). Não valida pixels/nível visual.
- `sidebar-navigation.test.tsx`: SSR do renderer com raiz recolhida (não renderiza
  descendentes) — valida comportamento de estado, não a estética da cadeia.
- `domain-back-button.test.tsx`: SSR do voltar (home=lista).
- `obra-gestao.test.tsx` / `obra-repository.test.ts`: lista/criação/reload/isolamento.
- NÃO cobertos (testes de componente/presencial): a representação visual em
  profundidade da cadeia Engenharia→Obras→Obra→módulos, e o modo "icon/collapsed".

## 13. Generalização para outros domínios [CONFIRMADO]
- Nenhum `if (domain/engenharia/obra/EAP/planejamento)` em componentes genéricos do
  Core/sidebar (busca). Ocorrências de "Engenharia/Obra" no Core = apenas comentários.
- Um futuro domínio Administração pode registrar `navigation` com
  `Empresas → Empresa A → módulos` sem tocar no Core (mesmo formato `NavigationNode`).

## 14. Diferenças (mapa)
| Item | Atual | Desejado | Situação |
|---|---|---|---|
| Domínios | rótulo de seção (não nó) | agrupamento topo (conceito) | CORRETO (conceitual) |
| Engenharia | nó raiz do domínio (chevron) | nó Engenharia → Obras | CORRETO (dados) |
| Obras | group sem rota, filhos obras | group Obras | CORRETO (dados) |
| Obra | entity com módulos | entity com módulos (mais módulos futuros) | CORRETO (base); módulos extras FUTURO |
| Módulos | 7 módulos atuais | 7 + caracterização/serviços/orçamento/… | FUTURO |
| + Nova obra | node entity real antes das obras | mesmo | CORRETO |
| Contexto | obraId da URL | mesmo | CORRETO |
| Superfície da árvore | só visível na sessão; rotas /dominios fora da sidebar | — | DÍVIDA/UX (ver §15) |

## 15. Riscos e limitações [HIPÓTESE + CONFIRMADO]
- [CONFIRMADO] DOMÍNIOS não é um nó navegável: pode parecer que falta o nível
  "DOMÍNIOS" visual, mas isso é o desenho conceitual (seção).
- [CONFIRMADO] A árvore só acompanha a superfície de sessão; dentro de uma rota de
  domínio a sidebar DOMÍNIOS não está presente (superfícies separadas). A imagem
  citada (obra + módulos + obras irmãs sem "Engenharia/Obras" visíveis) é compatível
  com: (a) recorte da visualização; ou (b) nós "Engenharia/Obras" acima fora do
  trecho; NÃO é compatível com achatamento de dados (nenhum nível é descartado no
  render). Verificação visual adicional é recomendada.
- [CONFIRMADO] Nós com filhos (Engenharia, Obras, Obra) **alternam** no clique; a
  "abertura" da obra acontece nos filhos folha (módulos) — UX de "entrar na obra"
  pelo item raiz não existe hoje (DECISÃO DE UX atual do renderer genérico).

## 16. Classificação
- Nível DOMÍNIOS como seção: **CORRETO** (arquitetura).
- Cadeia Engenharia→Obras→Obra→módulos em dados: **CORRETO**.
- Indentação/representação: **DECISÃO DE UX** (discreta; pode ser reforçada).
- Superfície da árvore restrita à sessão: **DÍVIDA ARQUITETURAL/UX** (futuro avaliar
  shell de domínio com sidebar própria ou trilho).
- Módulos extras (caracterização, etc.): **FUTURO**.
## 17. Recomendação
**Opção C (recomendada) — consolidar a representação visual da cadeia
`Engenharia → Obras`** (sem alterar dados/roteamento):
- Manter `DOMÍNIOS` como seção e a árvore de dados atual (CORRETO).
- Ajustar a leitura visual da cadeia na sidebar da sessão para deixar explícito
  o nível `Obras` e o fato de a obra estar contida nele (ex.: realce do nó ativo,
  indentação/estilo da cadeia), sem achatamento e sem criar abstração nova.
- NÃO mudar o Core nem a fonte de dados nesta fase.

Justificativa por critério:
1. Arquitetura atual: baixo risco — mudança restrita a apresentação (renderer/estilos).
2. Administração/Direito: mesma árvore data-driven → ganho de legibilidade no padrão
   `Domínio → Coletivo(Ex.: Obras/Empresas) → Entidade → Módulos`.
3. Comercialização futura: a clareza do aninhamento apoia venda de módulos por entidade.
4. Manutenção: sem alteração de contrato; apenas componente de apresentação.
5. Domínio/contexto: obraId/URL permanecem como fonte.
6. Agentes especialistas futuros: legibilidade hierárquica facilita apontar o contexto.

## 18. Escopo futuro (não implementar nesta fase)
- [FUTURO] Avaliar shell de domínio com a sidebar presente nas rotas `/dominios/*`
  (hoje a árvore só existe na superfície de sessão).
- [FUTURO] Módulos adicionais da obra (caracterização, serviços, orçamento, etc.).
- [FUTURO] Testes de apresentação em profundidade (multi-nível) da sidebar.

## 19. Evidências
- `obra-navigation.ts` L39-65 — árvore real (raiz/Obras/+Nova/obras/módulos).
- `domain-sidebar-group.tsx` L19-37 — seção DOMÍNIOS (rótulo) + `listDomains` +
  renderer genérico.
- `sidebar-navigation.tsx` L26-40 (lista recursiva), L61-67 (clique: expandir vs
  navegar), L71/L97-99 (indentação), L54-59 (auto-expand de ancestrais).
- `domain-registry.ts`, `domain-sidebar-group.tsx`, `domain-route.tsx`,
  `domain-back-button.tsx`, `navigation/*` — busca por termos de domínio =
  somente comentários de design (nenhum `if` de domínio no Core).
- `app-sidebar.tsx` L1233 — `<DomainsSidebarGroup/>` dentro da sidebar da sessão.
- `domain.tsx#renderRoute` + `obra-routes.ts` — rotas lista/nova/obraId/modulo.
- `obra-store.ts` (`selectedModules[obraId]`), `navigation-state.ts` (expansão por
  id de nó) — contexto não vaza entre obras.

## 20. Veredito
> **A sidebar atual representa corretamente a arquitetura Core → Domínio → Entidade →
> Módulo nos DADOS e na renderização recursiva (nenhum nível é achatado). "DOMÍNIOS" é
> um agrupamento conceitual (seção), não um nó — coerente com o desenho.** A percepção
> de perda de nível vem da representação visual discreta e do fato de a árvore DOMÍNIOS
> só estar presente na superfície de sessão (as rotas `/dominios/*` não exibem essa
> sidebar). Correção NÃO é arquitetural; é de apresentação (Opção C) + decisão futura
> de superfície.

> **A estrutura está preparada para Engenharia hoje e para Administração/Direito amanhã
> sem contaminar o Core: SIM** — o Core renderiza `NavigationNode[]` e não contém
> nenhuma referência a Engenharia/Obra/EAP/Planejamento (apenas comentários); novos
> domínios registram navegação própria sem alterar o Core.

## Notas de validação
Fase read-only: sem execução de suíte (nenhuma alteração). Comandos usados apenas para
inspeção: leitura de arquivos e buscas textuais (finalidade: evidências desta auditoria).

## Git
Nenhum commit. `git status` confirmado sem alterações de implementação nesta fase
(apenas este documento de auditoria foi criado).


