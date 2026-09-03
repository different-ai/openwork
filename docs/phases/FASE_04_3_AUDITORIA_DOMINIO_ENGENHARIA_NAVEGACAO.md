# FASE 04.3 — AUDITORIA DO DOMÍNIO ENGENHARIA E NAVEGAÇÃO DA OBRA (read-only)

> **Data:** 2026-01-09 · **Tipo:** auditoria — nenhuma alteração de código.

## 1. Objetivo
Auditar a integração Core → Domínio → Entidade → Módulos (Engenharia/Obras/Obra)
após as FASES 04.2-C/D, sem reauditar o que já foi aprovado e sem implementar.

## 2. Arquivos auditados (reais)
`domain-registry.ts` · `domain-bootstrap.ts` · `domain-route.tsx` ·
`domain-back-button.tsx` · `domain-sidebar-group.tsx` ·
`navigation/{navigation-types,navigation-state,navigation-utils,sidebar-navigation}` ·
`engenharia/domain.tsx` · `engenharia/obra/{obra-navigation,obra-routes,
obra-repository,obra-store,obra-shell-route,obra-types,obra-storage,obra-help}` ·
`engenharia/obra/pages/{obra-lista,obra-nova,obra-visao-geral,obra-eap,
obra-planejamento,obra-modulo-placeholder}` · `session/sidebar/app-sidebar.tsx` · `app-root.tsx`.

## 3. Domain Registry [APROVADO]
- `DomainDefinition { id; label; homeRoute; navigation: NavigationNode[]; renderRoute }`
  (`domain-registry.ts` L7-16).
- Engenharia registrada via side-effect no ponto único `domain-bootstrap.ts` L4.
- Registry não conhece módulos de Engenharia (sem `if`/referência a Obra/EAP).
- Navegação fornecida pelo domínio (dados); Core apenas interpreta.
- `listDomains`/`getDomain` compartilhados pela sidebar e pelo `DomainRoute`.

## 4. Navegação da Obra [APROVADO]
`obra-navigation.ts#buildEngenhariaNavigation(obras = SEED_OBRAS)` produz:
```text
Engenharia        (type domain · rota /dominios/engenharia/obras)
└── Obras         (type group · sem rota)
    ├── + Nova obra   (entity · rota .../obras/nova)
    └── por obra      (entity · rota .../obras/{id})
        └── módulos reais (7): Visão Geral · EAP · Frentes de Serviço ·
            Planejamento · Produção · RDO · IA
```
- Labels/rotas dos módulos em `obra-routes.ts` (`OBRA_MODULES`, `OBRA_MODULE_LABEL`).
- Sem ícones/metadados/permissões por nó no modelo atual (responsabilidade futura).

## 5. Entidade Obra [APROVADO]
- `Obra` vive no domínio (`obra-types.ts`); `caracterizacao?/eap?` opcionais (04.2-B).
- Nenhum componente do Core/sessão/workspace a trata como domínio/Core/infra.
  Ocorrências de "engenharia" fora do domínio = comentários + bootstrap (registro).

## 6. Rotas [APROVADO]
```text
/dominios/:domainId                → DomainRoute (Core) → renderRoute do domínio
/dominios/engenharia/obras         → ObraListaPage (lista)
/dominios/engenharia/obras/nova    → ObraNovaPage (criação)
/dominios/engenharia/obras/:obraId → ObraShellRoute (Visão Geral default)
/dominios/engenharia/obras/:obraId/:modulo → ObraShellRoute
```
- Coerência nó↔rota; `obraId` sempre presente nas rotas de obra; URLs geradas por
  `obraRoute()`. Sem duplicidade relevante.
## 7. Acoplamento / dependências [APROVADO]
- Ocorrências de "engenharia" fora do domínio: comentários de design
  (`navigation-types`, `sidebar-navigation`, `app-sidebar` L1232, `domain-registry`,
  `domain-route`, `domain-sidebar-group`, `domain-back-button`) e `domain-bootstrap` L4
  (registro, legítimo). Nenhum import funcional Core→Engenharia.
- Domínio → Core: importa tipos (`navigation-types`) e `registerDomain` (contrato) —
  legítimo. Obra → capacidade genérica `planejamento` (`obra-planejamento.tsx`) —
  direção correta. Nenhuma dependência invertida.

## 8. Extensibilidade [APROVADO]
- Novo domínio (Administração): novo módulo `domains/administracao/domain.tsx` +
  import no `domain-bootstrap` — sem mudar Core/renderer.
- Nova entidade (Empresa) e novo módulo (Financeiro): novos `NavigationNode[]` no
  domínio — renderer recursivo genérico não exige lógica especial.

## 9. Estado [APROVADO]
- Domínio/obra/módulo: derivados da URL (`domainId`, `obraId`, segmento de módulo).
- `obra-store`: `selectedModules[obraId]` (lembrança; não decide contexto).
- `navigation-state`: expansão por `node.id` (ids incluem `obra.id`).
- Separação sessão/domínio/entidade/navegação/rota respeitada.

## 10. Testes existentes [APROVADO]
Executados (somente leitura): **60 PASS / 0 FAIL** nos 9 arquivos relacionados
(engenharia-navigation, engenharia-obra-domain, sidebar-navigation, domain-back-button,
obra-gestao, obra-repository, planning-data, planning-dashboard, planning-anti-hardcode).
Nenhum teste modificado/criado.

## 11. Regressão visual [ATENÇÃO]
A alteração 04.2-D (classes no renderer) não gerou regressão funcional (testes SSR
PASS). Inspeção visual manual GUI não executada nesta auditoria — ATENÇÃO não
bloqueante (validação visual a cargo do usuário).

## 12. Problemas encontrados
- [ATENÇÃO] Árvore DOMÍNIOS só exibida na superfície de sessão; rotas `/dominios/*`
  não exibem essa sidebar (dívida de superfície, 04.2-C §18).
- [ATENÇÃO] Módulos da arquitetura-alvo (Caracterização, Serviços, Orçamento etc.)
  ainda não existem como módulos — FUTURO, sem impacto no mecanismo.
- [INFO] Persistência de obras é local/temporária (backend é FUTURO) — sem impacto
  nesta auditoria.

## 13. Veredito
`APROVADO` — sem BLOQUEIO arquitetural; ATENÇÕES não bloqueantes registradas.

## Git
Estado registrado (`git status`); sem alterações de implementação nesta fase; sem
add/commit/reset/checkout.

## Convenção de documentação
Fases 04.x do clone ficam em `docs/phases/` (verificado nesta fase). Nenhum arquivo de
código foi alterado.

