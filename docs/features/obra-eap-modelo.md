# Modelo de Domínio da EAP (Estrutura Analítica do Projeto) — Obra

> **Documento permanente** · Domínio Engenharia · FASE 06.2-B
> Última atualização: 2026-09-02

## 1. O que é

A **EAP (Estrutura Analítica do Projeto)** é o modelo de domínio que representa a
decomposição hierárquica do escopo de uma **Obra** em disciplinas, pacotes de
trabalho e trabalhos. É um conceito **próprio da Obra** — **não** reutiliza
`PlanningItem` (capacidade genérica de planejamento do domínio `planejamento/`).

A EAP é a base para o planejamento futuro (serviço → atividade → rede/CPM/Gantt),
mas nesta fase ela é tratada como **modelo de domínio navegável e persistido**,
sem avançar para planejamento, Skills, Agents, MCPs, CPM ou Gantt.

## 2. Onde vive

| Camada | Arquivo |
| --- | --- |
| Tipos | `apps/app/src/react-app/domains/engenharia/obra/obra-eap-types.ts` |
| Dados (81 nós reais) | `apps/app/src/react-app/domains/engenharia/obra/obra-eap-data.ts` |
| Repositório + helpers puros | `apps/app/src/react-app/domains/engenharia/obra/obra-eap-repository.ts` |
| Persistência (localStorage) | `apps/app/src/react-app/domains/engenharia/obra/obra-eap-storage.ts` |
| Referência reutilizável | `apps/app/src/react-app/domains/engenharia/obra/obra-eap-reference.ts` |
| Árvore navegável (UI) | `apps/app/src/react-app/domains/engenharia/obra/obra-eap-tree.tsx` |
| Página | `apps/app/src/react-app/domains/engenharia/obra/pages/obra-eap.tsx` |
| Inicialização | `apps/app/src/react-app/domains/engenharia/domain.tsx` |

## 3. Dono

A EAP pertence ao **domínio Engenharia**, subdomínio **Obra**
(`domains/engenharia/obra/`). É persistida **por `obraId`** — cada Obra tem sua
própria EAP. Não há banco paralelo nem segunda fonte de verdade para a Obra.

## 4. Estrutura do modelo

### 4.1 Nó (`ObraEapNode`)

| Campo | Tipo | Descrição |
| --- | --- | --- |
| `obraId` | `string` | Obra à qual o nó pertence (identidade composta). |
| `wbs` | `string` | Identificador hierárquico oficial (ex.: `1`, `1.1`, `1.1.1`). |
| `nome` | `string` | Nome do nó. |
| `nivel` | `number` | Nível hierárquico (1 = DISCIPLINA, 2 = PACOTE, 3 = TRABALHO). |
| `tipo` | `"DISCIPLINA" \| "PACOTE" \| "TRABALHO"` | Tipo do nó. |
| `pai` | `string \| null` | WBS do nó pai; `null` para raízes (nível 1). |
| `ordem` | `number` | Ordem entre irmãos (ordem de ocorrência na fonte, pré-order). |
| `fundamentacao` | `string \| null` | Fundamentação do nó (preservada da fonte). |
| `condicao` | `string \| null` | Condição/hipótese do nó (preservada da fonte). |

### 4.2 Metadados (`ObraEapMetadata`)

Preserva os metadados do documento oficial: `obraId`, `obraNome`, `status`,
`versao`, `caracterizacaoRef`, `regraAlocacaoEstruturaCobertura`, `niveisTipos`,
`principios`, `noTemplate`, `caracterizacaoResumo`.

### 4.3 EAP completa (`ObraEap`)

`{ obraId, metadata, nodes }` — metadados + nós de uma Obra.

### 4.4 Resumo (`ObraEapSummary`)

`{ status, total, raizes, pacotes, trabalhos }` — **sempre derivado** dos nós via
`deriveEapSummary`. **Nunca** é uma fonte independente de números.

## 5. Identidade

A identidade natural de um nó é **`obraId` + `wbs`**. O mesmo WBS em obras
diferentes **não** representa o mesmo nó operacional. Por isso a EAP é persistida
e consultada **por `obraId`**.

## 6. Persistência

Arquitetura: **UI → repository → storage**. A UI nunca toca em `localStorage`.

- Store Zustand `useObraEapRepository` mantém `eaps: Record<obraId, ObraEap>`.
- `setEap` / `resetEaps` gravam no armazenamento local (chave
  `openwork.obra-eap.v1`, versão 1).
- `initializeObraEapRepository()` hidrata o store a partir do armazenamento na
  inicialização do domínio.
- `resetObraEapRepository()` limpa a persistência e restaura os seeds (testes).

## 7. Relações

- A EAP é **fonte única** dos nós da Obra. O resumo é derivado, nunca paralelo.
- A **Obra Modelo EAP** (`OBRA-MODELO-EAP-001`) é a primeira **referência
  reutilizável** (`REF-EAP-RES-001`) da biblioteca de EAPs modelo — ver §9.
- A capacidade genérica de planejamento (`domains/planejamento/`) permanece
  **neutra / anti-hardcode** e **não** é reutilizada para a EAP.

## 8. Obra Modelo EAP (81 nós)

A EAP real da Obra Modelo EAP foi transcrita integralmente da fonte oficial
(read-only, proveniência):

`C:\Users\Correta Engenharia\OBRAS-MODELO\OBRA-MODELO-EAP-001\data\eap\OBRA-MODELO-EAP-001-eap.json`

- **Status:** `PROPOSTA` · **Versão:** `FASE-19.5`
- **Total:** 81 nós = **10 DISCIPLINA** / **24 PACOTE** / **47 TRABALHO**
- **Raízes:** 10 · **Folhas:** 47
- **Obra:** "Edifício Residencial Modelo EAP" (1 torre, 14 lajes, pilotis,
  sobresolo, 1 unidade por pavimento, sem subsolo, concreto armado, cobertura
  prevista).

Os 81 nós vivem em `obra-eap-data.ts` (`OBRA_MODELO_EAP_NODES`), com todos os
campos preservados (`wbs`, `nome`, `nivel`, `tipo`, `pai`, `ordem`,
`fundamentacao`, `condicao`). **Não** houve renumeração de WBS nem remoção de
campos.

> **Importante:** a Obra Modelo EAP é uma **referência**, **não** um template
> universal nem fonte operacional das outras obras. Cada Obra tem sua própria EAP.

## 9. EapReference (referência reutilizável)

`EapReference` é um conceito que permite a futura Skill/Agent **selecionar,
analisar e adaptar** EAPs modelo para novas obras.

- **Não** substitui a EAP operacional da Obra.
- **Não** embute os 81 nós — referencia a origem por `origemObraId`, evitando
  duplicação de dados.
- `resolveReferenceNodes(reference)` resolve os nós a partir da EAP operacional
  da origem.
- `findEapReference(id)` busca por id.

Primeira referência: **`REF-EAP-RES-001`** ("EAP Residencial Completo"),
`origemObraId = "OBRA-MODELO-EAP-001"`, versão `FASE-19.5`, com caracterização,
princípios e regras observadas.

## 10. EAP operacional vs EapReference (proveniência)

| Aspecto | EAP operacional | EapReference |
| --- | --- | --- |
| Papel | Modelo de domínio da Obra | Referência reutilizável para novas obras |
| Dados | Nós reais por `obraId` | Aponta para a origem (`origemObraId`) |
| Duplicação | Fonte única | Não embute os nós |
| Uso futuro | Base do planejamento | Seleção/adaptação por Skills/Agents |

## 11. Validação estrutural

`validateEap(nodes)` espelha o verificador oficial e verifica: WBS duplicados,
pais inexistentes, raízes com pai, ciclos e nós fora da obra. O resumo derivado
confere com a fonte: 81 = 10/24/47, 10 raízes, 47 folhas.

## 12. Testes

- `apps/app/tests/obra-eap.test.ts` — integridade (81/10/24/47/10/47), duplicados,
  pais inexistentes, raízes com pai, ciclos, fora-da-obra, resumo derivado,
  linhas de árvore, referência.
- `apps/app/tests/obra-eap-ui.test.tsx` — renderização SSR da página e da árvore.

Execução: `bun test tests/obra-eap.test.ts tests/obra-eap-ui.test.tsx`
(24 testes, 0 falhas). Regressão nas áreas tocadas: 84 testes, 0 falhas.

## 13. Limitações / fora de escopo desta fase

- **Não** avança para planejamento, Skills, Agents, MCPs, CPM, Gantt ou LOB.
- A EAP é navegável e persistida, mas ainda não alimenta o cronograma.
- A Obra Modelo EAP é referência, não template universal.
