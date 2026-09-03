# FASE 04.2-D — CORREÇÃO VISUAL DA HIERARQUIA DA SIDEBAR

> **Data:** 2026-01-09 · **Tipo:** correção de apresentação (renderer genérico).
> **Clone:** `OPENWORK-LAB\openwork`. Auditoria base: `FASE_04_2_C_AUDITORIA_SIDEBAR_DOMINIO.md`.

## 1. Objetivo
Tornar visualmente inequívoca a cadeia `DOMÍNIOS → Domínio → Entidade → Módulo`
na sidebar da sessão, **sem** alterar arquitetura, dados, rotas ou Core.

## 2. Decisão aplicada (Opção C da 04.2-C)
Ajuste exclusivo na camada de apresentação (`SidebarNavigationList`), conforme a
especificação da auditoria: realce do nó ativo, indentação/estilo da cadeia,
sem achatamento e sem abstração nova.

## 3. Arquivo alterado
- `apps/app/src/react-app/domains/navigation/sidebar-navigation.tsx` (renderer genérico).

## 4. Alteração visual (somente CSS/classes)
- Tipografia por **tipo de nó** (propriedade genérica de apresentação):
  `domain` (semibold), `group` (label compacto, uppercase, destaque suave),
  `entity` (medium), `module` (regular, cor mais suave).
- Item **ativo** com destaque uniforme (`bg-sidebar-accent` + `font-semibold text-foreground`).
- Guia vertical de profundidade mais visível nos filhos
  (`ms-2.5 border-l-2 … ps-2.5`) — a indentação cresce a cada nível sem remover níveis.
- Leve separação superior dos nós raiz de cada domínio.

## 5. Comportamento preservado
Expansão/recolhimento (estado `navigation-state`), auto-expansão de ancestrais,
navegação por rota, seleção do item atual via `useLocation`, `data-nav-*`,
`aria-expanded`, chevron, acessibilidade (focus ring) — inalterados.

## 6. Arquitetura
**PRESERVADA.** `NavigationNode[]` continua sendo a fonte; renderer permanece
recursivo e genérico; nenhuma regra de domínio foi adicionada (verificação por
busca: ocorrências de "engenharia/obra/EAP/Planejamento" no módulo alterado =
somente comentários).

## 7. Validação
```text
Testes:    42 PASS / 0 FAIL  (sidebar-navigation, engenharia-navigation,
            domain-back-button, obra-gestao, obra-repository, engenharia-obra-domain)
Typecheck: PASS  (pnpm --filter @openwork/app typecheck → exit 0)
Build:     PASS  (pnpm --filter @openwork/app build → ✓ in 47.96s)
Busca arquitetural: nenhuma condicional de domínio introduzida.
```

## 8. Git
- `git status` inicial e final registrados (o arquivo alterado faz parte da pasta de
  navegação não-commitada — `git diff` não cobre arquivos untracked; a alteração foi
  revisada via diff do editor).
- Commit: **NÃO**.

## 9. Verificação da convenção de documentação
Fases 04.x do clone estão em `docs/phases/` (FASE_04_1, FASE_04_2_A/B/C); `lab-docs`
não contém fases do clone. Este relatório segue a convenção vigente.

## 10. Próximos passos (FUTURO — não executados nesta fase)
- [FUTURO] Avaliar shell de domínio com a árvore presente nas rotas `/dominios/*`.
- [FUTURO] Testes de apresentação multi-nível da sidebar (visual/presencial).
