# FASE 04.2-B — GESTÃO DE OBRAS V1 (domínio Engenharia)

> **Data:** 2026-01-09 · **Tipo:** implementação (lista + criação + navegação dinâmica + persistência local).
> **Clone:** `OPENWORK-LAB\openwork`.

## 1. Objetivo
Evoluir `Obras` de nó estático com uma obra demonstrativa para uma **entidade
gerenciável multi-obra**: listar, abrir e criar obras, com navegação dinâmica,
ID estável e persistência local — mantendo o Core genérico.

## 2. Problema anterior (CONFIRMADO na FASE 04.2-A)
- `OBRAS_MODELO` existia, mas a navegação/rotas assumiam 1 obra fixa.
- Não havia lista, criação, seleção nem persistência de obras.
- `obra-store.selectedModule` era global (risco de vazamento entre obras).

## 3. Auditoria que fundamentou
`docs/phases/FASE_04_2_A_AUDITORIA_GESTAO_OBRAS.md` — conclusões: Obra pertence ao
domínio Engenharia; fonte única inexistente como serviço; sem duplicação interna;
recommendação de repositório no domínio com navegação data-driven.

## 4. Modelo de Obra (IMPLEMENTADO)
`obra-types.ts`: `Obra { id; nome; status: "PROPOSTA"; caracterizacao?; eap? }` —
caracterização/EAP agora **opcionais** (obra nova nasce só com identificação).
Novo `CreateObraInput { nome; status? }`.

## 5. Repository (IMPLEMENTADO) — FONTE ÚNICA
`obra-repository.ts`: store Zustand (`useObraRepository`) + helpers
`listObras()`, `findObraById(id)`, `createObra(input)`, `SEED_OBRAS`,
`OBRA_MODELO_ID`, `resetObraRepository()`. A lista, a navegação e as páginas
consomem esta única fonte. `obra-data.ts` foi **removido** (fonte única).

## 6. Armazenamento (IMPLEMENTADO — local e temporário)
`obra-storage.ts` encapsula `localStorage` (`openwork.obra-repository.v1`,
versionado). Arquitetura `UI → repository → storage`; a UI nunca toca em
localStorage. Persistência V1 é **local e temporária** (troca por backend = só
esta camada muda). FORA DE ESCOPO: backend/API/banco/Supabase.

## 7. Geração de ID (IMPLEMENTADO)
`createObraId()` → `OBRA-<timestamp36+aleatório>` (upper). Não usa nome, não usa
índice; único (checagem contra ids existentes); seguro para URL.

## 8. Navegação dinâmica (IMPLEMENTADO)
`obra-navigation.ts#buildEngenhariaNavigation(obras = SEED_OBRAS)` monta
`Engenharia → Obras → [+ Nova obra + obra1 + obra2 …]` (cada obra com módulos).
O `domain.tsx` registra/re-registra o domínio a partir do repositório e
re-registra quando o repositório muda (a sidebar relê ao remontar a sessão).
Nenhum conceito de obra foi adicionado ao Core.

## 9. Rota `/obras` (IMPLEMENTADO)
`/dominios/engenharia/obras` → `ObraListaPage` (lista com Nome/Status/Abrir e
botão "+ Nova obra"). `homeRoute` do domínio = lista. Rotas antigas
`/obras/:obraId[/:modulo]` preservadas.

## 10. Criação (IMPLEMENTADO)
`/dominios/engenharia/obras/nova` → `ObraNovaPage` (formulário mínimo: Nome;
status default `PROPOSTA`; validação mínima com botão desabilitado sem nome).

## 11. Fluxo de criação (IMPLEMENTADO)
`+ Nova obra → formulário → Criar → repository.createObra → persistência local →
lista reativa → navega para a obra criada (obraId na URL)`.

## 12. Relação com caracterização (FUTURO)
Obra nova nasce sem caracterização; páginas tratam ausência (mensagens). A
caracterização permanece como etapa futura, sem duplicar o modelo existente.

## 13. Relação com EAP (PRESERVADO / FUTURO)
EAP inalterada; `obra.eap` opcional (obra-modelo preserva o resumo 10/24/47=81).
Vínculo por `obraId` futuro.

## 14. Relação com planejamento (PRESERVADO)
`ObraPlanejamento` (FASE 04.1) continua recebendo a obra por prop e exibindo o
contexto dinâmico (sem hardcode). Dashboard intacta.
## 15. Estado de UI (IMPLEMENTADO — correção de `selectedModule`)
`obra-store.ts` agora mantém `selectedModules: Record<obraId, ObraModule|null>`
(escopo por obra). A obra aberta continua vinda da **URL** (`obraId`), nunca do
store. Mudança mínima e documentada; chamador único atualizado
(`ObraShellRoute`).

## 16. Decisão sobre `selectedModule` (IMPLEMENTADO)
Risco de vazamento entre obras eliminado: módulo selecionado é por `obraId`; a
rota (não o store) decide o módulo exibido.

## 17. Compatibilidade com a obra existente (PRESERVADO)
`OBRA-MODELO-EAP-001` mantida como **seed/fixture** (com caracterização e EAP)
para não quebrar módulos/rotas/EAP. Verificada por testes. Classificação da
ocorrência no código: **SEED/COMPATIBILIDADE** (`obra-repository.ts`).

## 18. Testes (IMPLEMENTADO — executados)
- `tests/obra-repository.test.ts` (7) — seeds, list/find, create/id único,
  persistência e **reload** (storage + re-hidratação), reset.
- `tests/obra-gestao.test.tsx` (7) — SSR da lista/criação, obra criada na
  lista, estado vazio, compat da obra-modelo, planejamento com contexto
  dinâmico e isolamento do estado por obra.
- Atualizados: `engenharia-navigation`, `engenharia-obra-domain`,
  `domain-back-button` (nova home = lista). Planejamento mantém 18 testes.

## 19. Typecheck (PASS)
`pnpm --filter @openwork/app typecheck` → exit 0.

## 20. Build (PASS)
`pnpm --filter @openwork/app build` → ✓ built (warnings pré-existentes).

## 21. Reload test (PASS)
Teste de re-hidratação: criar obra → storage contém → zerar memória → `initializeObraRepository()` → obra permanece e é encontrável (`findObraById`). (Simulado com storage em memória, pois Bun não expõe `localStorage`.)

## 22. Anti-hardcode (PASS — classificação)
Ocorrências de `OBRA-MODELO-EAP-001`:
- `obra-repository.ts` (L19) → **SEED/COMPATIBILIDADE** (preservação da obra).
- Comentários/rotas restantes → removidos ou tornados genéricos (ex.:
  `domain-registry` usa `/obras/:obraId/eap`; página EAP sem literal).
- Ocorrências em testes → **TESTE** (expectativas de seed).
- Docs → **DOCUMENTAÇÃO**.
Sem hardcode estrutural: navegação e UI derivam do repositório.

## 23. Limitações (FUTURO / FORA DE ESCOPO)
- Persistência local temporária (sem backend/banco).
- Cadastro mínimo (nome/status); caracterização/EAP completas e demais módulos
  são etapas futuras.
- Sidebar DOMÍNIOS reflete a lista quando remonta a sessão (sem push reativo
  ao vivo dentro da própria sidebar).
- Sem edição, permissões, compartilhamento, colaboração, remoção.

## 24. Evolução futura para backend (FUTURO)
Trocar `obra-storage.ts` por persistência via servidor OpenWork local (SQLite)
quando houver necessidade de compartilhamento/durabilidade fora da máquina.
Nenhuma mudança no Core será necessária (o domínio continua a expor o
repositório).

## Verificação da fase
- [x] repository · [x] fonte única · [x] ≥2 obras · [x] navegação dinâmica
- [x] lista · [x] + Nova obra · [x] formulário · [x] criação · [x] ID estável
- [x] persistência local · [x] reload · [x] abertura por URL · [x] obra preservada
- [x] planejamento ok · [x] EAP preservado · [x] estado isolado por obra
- [x] testes · [x] typecheck · [x] build · [x] documentação · [x] anti-hardcode

