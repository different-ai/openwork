# Modelo Canônico de Planejamento de Obras — Especificação Arquitetural

> **Status: ESPECIFICAÇÃO PARA APROVAÇÃO (somente análise e arquitetura — nenhum código alterado).**
> Data: 2026-09-03 · Domínio: Engenharia · Obra de referência: `OBRA-MODELO-EAP-001`
> Base: auditoria aprovada `docs/features/auditoria-editabilidade-modelo-obra.md`
>
> **Regra de evidência:** cada conclusão foi validada contra o código real
> (`apps/app/src/react-app/domains/engenharia/obra/**` e `domains/{planejamento,servicos,linha-de-balanco}/**`).
> Conclusões que não puderem ser comprovadas pelo código são marcadas como `NÃO VERIFICADO`.

---

## 0. Objetivo e princípios

### Objetivo
Definir o **núcleo canônico de planejamento de obras** que futuramente sustentará o
OpenWork/ARES, permitindo trabalhar com **obras diferentes sem criar código específico
para cada tipo de obra**.

### Princípios norteadores (validados no código)
1. **A Obra é a raiz de um grafo de dados configuráveis.** Nada é global/hardcoded.
2. **Fonte única de verdade por entidade.** Nunca duplicar; derivar quando possível.
3. **Derivação é calculadora, nunca fonte.** Gantt/CPM/LOB são derivados do planejamento.
4. **Capacidades genéricas neutras** (`domains/planejamento`, `servicos`, `linha-de-balanco`)
   não conhecem Obra; adapters traduzem o domínio para os contratos genéricos.
5. **Preservar** a EAP real de 81 nós, `OBRA-MODELO-EAP-001`, o isolamento ARES/Piemarta,
   as FASES 21/22 e a arquitetura de derivação correta.

---

## 1. OBRA — o que pertence à entidade Obra

### Situação atual (validado)
`Obra` em `obra-types.ts` contém: `id`, `nome`, `status` (union fixa), `dataInicio`/`dataFim`
(metadado do cadastro), `localizacao`, `responsavel`, `arquivada`, `caracterizacao` (shape fixo),
`eap` (resumo derivado). `ARQUIVADA` é derivado de `arquivada` (`statusEfetivo` em `obra-repository.ts`).

### O que pertence à Obra (fonte de verdade)
| Campo | Classificação | Observação |
|-------|---------------|------------|
| `id` | ESTRUTURAL / somente leitura | `createObraId` |
| `nome` | EDITÁVEL | `obra-editar.tsx` |
| `status` | EDITÁVEL (union fixa hoje) | Futuro: configurável por obra |
| `dataInicio` | EDITÁVEL (metadado cadastro) | **NÃO** é a data do cronograma |
| `dataFim` | EDITÁVEL (metadado cadastro) | idem |
| `localizacao` | EDITÁVEL | |
| `responsavel` | EDITÁVEL | |
| `arquivada` | EDITÁVEL (soft-delete) | |
| `tipoObra` | CONFIGURÁVEL (novo) | residencial/comercial/infraestrutura — **não assumir torre/laje** |

### O que NÃO pertence à Obra (fica em outras entidades)
- **EAP** → entidade própria por obra (`obra-eap-repository.ts` já é mapa por obraId).
- **Disciplinas** → entidade própria por obra.
- **Frentes** → entidade operacional por obra.
- **Locais** → entidade hierárquica por obra.
- **Serviços** → cadastro por obra.
- **Planejamento** → entidade por obra (baseline + overrides).
- **Produção** → registro por obra.
- **Caracterização** → campos dinâmicos por tipo de obra (não shape fixo).

**Decisão:** a Obra é a **raiz de identidade** (quem é a obra), não o contêiner de todos os
dados. Cada subdomínio é uma entidade própria vinculada por `obraId`.

---

## 2. EAP

### Situação atual (validado)
- `obra-eap-data.ts` hardcoda 81 nós com `obraId: OBRA_MODELO_EAP_ID` (10/24/47).
- `obra-eap-repository.ts` suporta `eaps: Record<string, ObraEap>` mas só seeda a obra-modelo.
- `validateEap.foraDaObra` (linha 146–148) marca como inválido qualquer nó cujo
  `obraId !== OBRA_MODELO_EAP_ID`.
- `obra-eap-reference.ts` define `REF_EAP_RES_001` (referência reutilizável, aponta para origem).

### Definição conceitual
| Aspecto | Definição |
|---------|-----------|
| **Identidade** | `obraId + wbs` (o mesmo WBS em obras diferentes NÃO é o mesmo nó) |
| **Vínculo com obra** | `obraId` em cada nó; repositório por obraId |
| **Hierarquia** | `wbs`, `nivel` (1/2/3), `pai`, `ordem` — árvore pré-order |
| **Edição/importação** | Cadastro por obra OU importação de referência → instância |
| **Relacionamento com serviços** | Nó TRABALHO (nível 3) é a base do serviço; serviço adiciona frente × local |
| **Relacionamento com atividades** | Atividade de planejamento referencia o serviço (que referencia o nó EAP) |
| **Versionamento** | Possível: `versao` já existe em `ObraEapMetadata`; baseline de EAP |

### Preservar
- **EAP real de 81 nós** da `OBRA-MODELO-EAP-001` — **NÃO alterar**.
- `obra-eap-reference.ts` como biblioteca de referências (não fonte operacional).

### Mudança necessária (P0, da auditoria)
- Remover a dependência da obra-modelo na validação (`validateEap.foraDaObra`).
- Expor UI de criação/edição/importação de EAP por obra.

---

## 3. DISCIPLINAS

### Situação atual (validado)
`obra-disciplinas.tsx` **deriva** as disciplinas dos nós nível 1 da EAP
(`nodes.filter((n) => n.nivel === 1)`). Não há entidade/configuração por obra.

### Análise conceitual
- **Hoje:** `EAP → Disciplina` (disciplina = nó nível 1).
- **Correto para o domínio:** `Disciplina → EAP`. A **Disciplina é a fonte de verdade**
  (especialidade/área do conhecimento); a EAP é a decomposição de entregáveis que
  **referencia** disciplinas. Uma disciplina pode existir sem EAP (ex.: planejada, ainda
  sem decomposição) e pode ter cor/ícone/ordem/código independentes.

### Definição conceitual
`Disciplina` por obra: `{ id, codigo, nome, ordem, cor?, icone?, arquivada? }`.
- **Entidade própria por obra** (não derivada).
- Nós do EAP (nível 1) **referenciam** a disciplina (ou a disciplina referencia os WBS).
- **Migração:** para a obra-modelo, as 10 disciplinas atuais (nível 1) viram o seed.

---

## 4. FRENTES

### Situação atual (validado)
`obra-frentes.tsx` **deriva** as frentes das disciplinas raiz da EAP
(`nodes.filter((n) => n.nivel === 1)`). Frente = natureza/especialidade do trabalho.

### Definição conceitual
`Frente` é uma **entidade operacional** por obra, com ciclo de vida próprio
(criar, editar, encerrar) e atributos que não vêm do EAP.

| Atributo | Relação | Classificação |
|----------|---------|---------------|
| `nome` | — | EDITÁVEL |
| `codigo` | — | EDITÁVEL |
| `disciplina` | → Disciplina | EDITÁVEL (referência) |
| `responsavel` | → (pessoa) | EDITÁVEL |
| `equipe` | → Equipe | EDITÁVEL (referência) |
| `status` | — | EDITÁVEL (ativa/encerrada) |
| `localizacao` | → Local | EDITÁVEL (referência) |
| `inicio`/`término` | — | EDITÁVEL |

**Relações:** Frente ↔ Disciplina (uma frente atua numa disciplina); Frente ↔ EAP
(indireta, via serviço); Frente ↔ Serviço (dimensão do serviço); Frente ↔ Local (onde atua);
Frente ↔ Equipe (quem executa).

---

## 5. LOCAIS

### Situação atual (validado)
**Não existe entidade de Locais/Unidades** no domínio Obra. A caracterização tem
`torres`, `lajes`, `apartamentosPorPavimento`, `subsolos` — **números agregados**, não
estrutura hierárquica. O dataset ARES tem `local: "LOCAL-T1"` mas não é consumido pela obra real.

### Definição conceitual
`Local` é uma **entidade hierárquica por obra**, genérica — **não assumir torre/laje/apartamento
como estrutura universal**.

```
Local = { id, nome, tipo, pai?, ordem }
```

| Tipo de obra | Exemplo de hierarquia de locais |
|--------------|---------------------------------|
| Residencial vertical | Torre → Pavimento → Unidade |
| Comercial | Bloco → Andar → Sala |
| Infraestrutura (rodoviária) | Trecho → Subtrecho → Km |
| Infraestrutura (hidráulica) | Trecho → Estação → Ponto |

**Relações:** Local ↔ Serviço (dimensão `LOCALIZAÇÃO`); Local ↔ Frente (onde atua);
Local ↔ Produção (onde foi executado).

**Migração:** para a obra-modelo, os locais seriam derivados da caracterização
(1 torre, 14 lajes, 1 apto/pavimento).

---

## 6. SERVIÇOS

### Situação atual (validado)
`obra-servicos-adapter.ts` **deriva** os serviços dos nós TRABALHO (nível 3) da EAP +
planejamento. `ServicoItem` tem `{id, codigo, nome, duracao, inicio, fim, status}` + campos
opcionais preparados (`unidade`, `quantidade`, `produtividade`, `predecessora`).

### Conceito `SERVIÇO = EAP × FRENTE × LOCALIZAÇÃO`
**Hoje NÃO está representado.** O serviço é apenas um nó TRABALHO com datas derivadas.
**Não há dimensão de frente nem de localização** no serviço.

### Definição conceitual
`Serviço` é o **principal elemento operacional da execução** — a interseção de um elemento
de escopo (EAP), uma frente (quem executa) e uma localização (onde).

```
Serviço = { id, obraId, eapWbs, frenteId, localId, quantidade, unidade, produtividade, predecessora }
```

- **Identidade composta:** `obraId + eapWbs + frenteId + localId` (o mesmo trabalho pode
  ocorrer em múltiplas frentes/locais).
- **Editável:** `quantidade`, `unidade`, `produtividade`, `predecessora`, `frenteId`, `localId`.
- **Derivado:** `duracao` (qtd/prod), `inicio`/`fim` (cronograma).

**Decisão:** **SIM** — o Serviço deve ser o principal elemento operacional da execução,
pois é onde escopo, responsabilidade e localização se encontram.

---

## 7. ATIVIDADES

### Definição conceitual
`Atividade` é a **entidade de planejamento** que representa uma unidade de trabalho no
cronograma. Ela referencia um Serviço (que referencia EAP × Frente × Local).

| Campo | Classificação | Observação |
|-------|---------------|------------|
| `id` | ESTRUTURAL | |
| `descricao` | EDITÁVEL | |
| `servicoId` | EDITÁVEL (referência) | vínculo com EAP/serviço |
| `quantidade` | EDITÁVEL | escopo |
| `unidade` | EDITÁVEL | |
| `produtividade` | EDITÁVEL | base de cálculo |
| `duracao` | DERIVADO (qtd/prod) OU EDITÁVEL (override) | |
| `inicio` | DERIVADO (cronograma) | |
| `termino` | DERIVADO | |
| `predecessoras` | EDITÁVEL | rede de precedência |
| `tipoRelacao` | EDITÁVEL | FS/SS/FF/SF |
| `calendario` | CONFIGURÁVEL (referência) | |
| `equipe/recurso` | EDITÁVEL (referência) | |
| `status` | DERIVADO (datas × realizado) | |
| `percentualPlan` | DERIVADO (curva S) | |
| `percentualReal` | CADASTRADO (vem da produção) | |

---

## 8. PLANEJAMENTO

### Situação atual (validado)
`obra-planejamento-data.ts` **deriva** o cronograma dos nós EAP + `OBRA_SCOPE_REF` +
`DATA_INICIO_OBRA`. `derivarPlanejamento` sequencia por disciplina, calcula duração
(qtd/prod), datas acumuladas, crítico (limiar 60%), predecessora (sequencial).
**Não há edição** — tudo é derivado deterministicamente.

### Definição conceitual
| Elemento | Classificação |
|----------|---------------|
| **Baseline** | DERIVADO (ponto de partida, do EAP + escopo) |
| **Planejamento atual** | EDITÁVEL (baseline + overrides) |
| **Alterações/overrides** | EDITÁVEL (duração, datas, rede) |
| **Datas** | DERIVADO (cronograma) OU EDITÁVEL (override) |
| **Duração** | DERIVADO (qtd/prod) OU EDITÁVEL (override) |
| **Predecessoras** | EDITÁVEL (rede) |
| **Calendário** | CONFIGURÁVEL |
| **Status** | DERIVADO |

### QUAL É A ÚNICA FONTE DE VERDADE DO CRONOGRAMA?
> **O PLANEJAMENTO (entidade de Atividades por obra) é a ÚNICA fonte de verdade do
> cronograma.** Gantt, CPM e LOB são **derivados** dele e **nunca** mantêm cronogramas
> independentes. A derivação atual (EAP + escopo → planejamento) é o **baseline**; o
> planejamento editável (com overrides) é a fonte operacional.

---

## 9. PRODUÇÃO

### Situação atual (validado)
`obra-producao.tsx` **deriva** a produção dos nós TRABALHO com duração + `OBRA_SCOPE_REF`.
Produção real marcada como **"Pendente"** (não registrada).

### Separação necessária
| Categoria | Dados | Editável? |
|-----------|-------|-----------|
| **Planejado** | quantidade planejada, produtividade, ritmo, meta, período | EDITÁVEL (cadastro) |
| **Realizado** | quantidade produzida, data, equipe, frente, responsável, observação | EDITÁVEL (registro) |
| **Derivado/calculado** | avanço, produtividade real, desvio, projeção, tendência | CALCULADO |

**Decisão:** o **realizado** deve ser registrado numa **entidade de produção real por obra**
(apontamentos diários/periódicos), separada do planejado. O avanço/desvio/projeção são
**derivados** da comparação planejado × realizado.

---

## 10. GANTT / CPM / LOB

### Validação da regra arquitetural
```
PLANEJAMENTO → GANTT
PLANEJAMENTO → CPM
PLANEJAMENTO → LOB
```
**VALIDADA.** Gantt, CPM e LOB **não podem manter cronogramas independentes** — todos são
**derivados** do planejamento. A LOB **deve continuar sendo calculadora/visualização derivada**
(validado: `obra-lob-data.ts` delega à capacidade genérica `domains/linha-de-balanco`, que é
pura e derivada).

---

## 11. RECURSOS / EQUIPES / CALENDÁRIOS

### Situação atual (validado)
**Não existem** entidades de Recursos, Equipes ou Calendários no domínio Obra. O dataset
ARES tem `equipe: "EQUIPE-001"` mas não é consumido pela obra real. O planejamento não
considera calendário (dias corridos a partir de `DATA_INICIO_OBRA`).

### Definição conceitual (fases posteriores)
- **Equipes:** entidade por obra `{ id, nome, frenteId?, responsavel?, membros? }`.
- **Recursos:** entidade por obra `{ id, nome, tipo, unidade, custo? }`.
- **Calendários:** entidade por obra `{ id, nome, diasUteis, feriados }`, usada no cálculo
  de datas do planejamento.

**Onde entram no modelo:** vinculados à Atividade (equipe/recurso/calendário) e à Frente
(equipe). São **referências**, não fontes de cronograma.

---

## 12. IA / AGENTE PLANEJADOR

> **NÃO IMPLEMENTAR.** Somente definição conceitual.

O futuro **Agente Planejador** deverá:
1. **Ler o modelo estruturado** (EAP, serviços, atividades, produção) por `obraId`.
2. **Analisar restrições** (predecessoras, calendário, recursos).
3. **Analisar produção** (planejado × realizado, desvios).
4. **Identificar impactos** (atrasos, caminho crítico, folgas).
5. **Propor alterações** (datas, durações, rede) como **propostas**.
6. **Justificar propostas** (motivo, evidência, impacto).
7. **Nunca alterar dados críticos automaticamente sem aprovação humana.**

O Agente opera **somente leitura** sobre o modelo; alterações são **propostas** que exigem
aprovação humana antes de virar override no planejamento.

---

## 13. TESTE DE GENERALIZAÇÃO — Obra A / B / C

Demonstração conceitual de como o **mesmo núcleo** atende três obras diferentes **sem
criar arquitetura diferente para cada uma**.

| Obra | Tipo | Locais | Disciplinas | Frentes | Como o núcleo representa |
|------|------|--------|-------------|---------|--------------------------|
| **A** | Residencial vertical | Torre → Pavimento → Unidade | 10 | 10 | EAP própria; locais hierárquicos; disciplinas/frentes cadastradas; serviços = EAP × frente × local |
| **B** | Edifício comercial | Bloco → Andar → Sala | 7 | 18 | Mesma estrutura, valores diferentes |
| **C** | Infraestrutura | Trecho → Subtrecho → Km | diferentes | diferentes | Caracterização dinâmica (sem torres/lajes); locais = trechos/km; disciplinas = terraplenagem/pavimentação/etc.; EAP própria |

**O que muda entre A/B/C:** apenas os **dados** (locais, disciplinas, frentes, EAP, escopo).
**O que NÃO muda:** o **núcleo** (entidades Obra/EAP/Disciplina/Frente/Local/Serviço/
Atividade/Planejamento/Produção + capacidades genéricas Gantt/CPM/LOB).

---

## 14. FONTES DE VERDADE — Matriz

| Entidade | Fonte de verdade | Derivado de | Editável | Calculado | Histórico |
|----------|------------------|-------------|----------|-----------|-----------|
| **Obra** | `obra-repository.ts` (lista) | — | nome, status, datas, localização, responsável | `ARQUIVADA` (de `arquivada`) | — |
| **Caracterização** | `Obra.caracterizacao` (dinâmico) | — | sim (futuro) | — | — |
| **Disciplinas** | Entidade por obra | — | sim | — | — |
| **EAP** | `obra-eap-repository.ts` (por obraId) | — | sim (futuro) | resumo (`deriveEapSummary`) | `versao` |
| **Locais** | Entidade por obra | — | sim | — | — |
| **Frentes** | Entidade por obra | — | sim | — | — |
| **Serviços** | Cadastro por obra | EAP × Frente × Local | quantidade, unidade, produtividade, predecessora | duração (qtd/prod) | — |
| **Atividades** | Entidade por obra | Serviço | descrição, quantidade, rede, overrides | duração, datas | — |
| **Planejamento** | **Entidade de Atividades por obra (ÚNICA fonte do cronograma)** | EAP + escopo (baseline) | overrides, rede, calendário | datas, crítico | baseline |
| **Produção** | Registro por obra (realizado) | — | quantidade, data, equipe | avanço/desvio (planejado × realizado) | apontamentos |
| **Gantt** | **NUNCA fonte** — derivado | Planejamento | — | sim | — |
| **CPM** | **NUNCA fonte** — derivado | Planejamento | — | sim | — |
| **LOB** | **NUNCA fonte** — derivado | Planejamento | — | sim | — |

---

## 15. CADEIA DE DEPENDÊNCIAS

### Cadeia proposta pelo usuário
```
OBRA → EAP → SERVIÇO → ATIVIDADE → PLANEJAMENTO → GANTT/CPM/LOB → PRODUÇÃO → CONTROLE
```

### Análise do código e ajuste recomendado
A cadeia proposta está **quase correta**, mas o código revela uma sutileza: **Produção
(realizado) não é derivada do planejamento** — ela é um **registro independente** que se
compara ao planejado. Além disso, **Serviço** depende de **Frente** e **Local** (dimensões
que não vêm da EAP). Cadeia ajustada:

```
OBRA
 ├── Disciplinas (entidade)
 ├── Locais (entidade hierárquica)
 ├── Frentes (entidade operacional)
 ├── EAP (por obra)
 │     └── (nós TRABALHO = base de escopo)
 ├── SERVIÇO = EAP × FRENTE × LOCAL  (cadastro)
 │     └── quantidade, unidade, produtividade, predecessora
 ├── ATIVIDADE (referencia serviço)
 │     └── rede, calendário, overrides
 ├── PLANEJAMENTO  ← ÚNICA FONTE DE VERDADE DO CRONOGRAMA
 │     ├── GANTT (derivado)
 │     ├── CPM   (derivado)
 │     └── LOB   (derivado)
 ├── PRODUÇÃO (registro do realizado — independente, comparado ao planejado)
 └── CONTROLE (derivado: planejado × realizado → avanço/desvio)
```

**Motivo do ajuste:** a cadeia original sugere que Produção deriva do planejamento, mas o
código mostra que produção real é um **registro** (não derivado). E a cadeia original omite
Frente/Local como dimensões do Serviço. O restante (EAP → Serviço → Atividade → Planejamento
→ Gantt/CPM/LOB) está correto.

---

## 16. HARD CODES — onde cada informação deveria morar

| # | Hardcode atual | Arquivo | Deveria morar em |
|---|----------------|---------|------------------|
| 1 | 81 nós EAP | `obra-eap-data.ts` | Entidade EAP por obra (cadastro/importação) |
| 2 | `OBRA_SCOPE_REF` (qtd/prod por WBS) | `obra-planejamento-data.ts` | Cadastro de Serviço por obra |
| 3 | `DATA_INICIO_OBRA` (05/01/2026) | `obra-planejamento-data.ts` | `obra.dataInicio` (metadado cadastro) |
| 4 | Caracterização (torres/lajes/aptos/subsolos) | `obra-types.ts` + seeds | Campos dinâmicos por tipo de obra |
| 5 | `validateEap.foraDaObra` (obraId fixo) | `obra-eap-repository.ts` | Validar contra a própria obra |
| 6 | `OBRA_MODELO_ID`/`OBRA_MODELO_EAP_ID` | `obra-repository.ts`/`obra-eap-data.ts` | Referência (não fonte operacional) |
| 7 | `REF_EAP_RES_001` | `obra-eap-reference.ts` | Biblioteca de referências (ok) |
| 8 | ARES/Piemarta (15 atv, 18 elos, 11 serv) | `obra-ares-referencia.ts` | Isolado (não consumido pela obra real) |
| 9 | `STATUS_OPTIONS` | `obra-lista.tsx`/`obra-editar.tsx`/`obra-nova.tsx` | Configurável por obra |
| 10 | `CAMPOS_CARACTERIZACAO` | `obra-caracterizacao.tsx`/`obra-visao-geral.tsx` | Configurável por tipo de obra |
| 11 | `OBRA_MODULES` (11 módulos) | `obra-modules.ts` | Catálogo declarativo (ok) |
| 12 | `OBRA_FASES_ORDER` | `obra-modules.ts` | Fixo (ok) |

---

## 17. DECISÕES ARQUITETURAIS

### D1 — Disciplinas: entidade própria vs derivada
1. **Situação atual:** derivadas do EAP nível 1 (`obra-disciplinas.tsx`).
2. **Problema:** não podem crescer/reduzir/ordenar; sem cor/ícone/código independentes;
   não podem existir sem EAP.
3. **Alternativa A (recomendada):** entidade por obra (`Disciplina`), EAP referencia.
4. **Alternativa B:** manter derivada (menor mudança, mas rígida).
5. **Recomendação:** A.
6. **Motivo:** `Disciplina → EAP` é o modelo correto do domínio; permite disciplina sem EAP.
7. **Impacto futuro:** migração das 10 atuais vira seed; obra-modelo continua funcionando.

### D2 — Frentes: entidade operacional
1. **Situação atual:** derivadas das disciplinas raiz (`obra-frentes.tsx`).
2. **Problema:** sem ciclo de vida (criar/editar/encerrar); sem responsável/equipe/local.
3. **Alternativa A (recomendada):** entidade operacional por obra.
4. **Alternativa B:** manter derivada.
5. **Recomendação:** A.
6. **Motivo:** frente tem atributos operacionais que não vêm do EAP.
7. **Impacto futuro:** habilita gestão de frentes e a dimensão FRENTE do serviço.

### D3 — Serviço como elemento operacional principal
1. **Situação atual:** derivado dos nós TRABALHO (`obra-servicos-adapter.ts`).
2. **Problema:** conceito `EAP × FRENTE × LOCALIZAÇÃO` não representado.
3. **Alternativa A (recomendada):** cadastro por obra (EAP × frente × local).
4. **Alternativa B:** manter derivado.
5. **Recomendação:** A.
6. **Motivo:** é onde escopo, responsabilidade e localização se encontram.
7. **Impacto futuro:** base para orçamento/medição/indicadores (FASE 22).

### D4 — Fonte de verdade do cronograma
1. **Situação atual:** derivado deterministicamente (`obra-planejamento-data.ts`).
2. **Problema:** cronograma não evolui; sem rede/calendário/overrides.
3. **Alternativa A (recomendada):** Planejamento (Atividades por obra) como única fonte;
   baseline derivado + overrides editáveis.
4. **Alternativa B:** manter derivado puro.
5. **Recomendação:** A.
6. **Motivo:** Gantt/CPM/LOB derivam do planejamento; sem fonte única, há múltiplas verdades.
7. **Impacto futuro:** habilita evolução do cronograma sem quebrar derivação.

### D5 — Produção: registro real separado
1. **Situação atual:** derivada/simulada, real "Pendente" (`obra-producao.tsx`).
2. **Problema:** dados fictícios tratados como reais; sem gestão real.
3. **Alternativa A (recomendada):** entidade de registro de produção real (realizado).
4. **Alternativa B:** manter derivada.
5. **Recomendação:** A.
6. **Motivo:** avanço/desvio são derivados de planejado × realizado.
7. **Impacto futuro:** habilita controle real de obra.

### D6 — Locais: estrutura genérica hierárquica
1. **Situação atual:** não existe; só números agregados na caracterização.
2. **Problema:** não representa obra não-residencial (infraestrutura, comercial).
3. **Alternativa A (recomendada):** entidade hierárquica genérica por obra.
4. **Alternativa B:** manter números agregados.
5. **Recomendação:** A.
6. **Motivo:** não assumir torre/laje/apartamento como universal.
7. **Impacto futuro:** habilita Obra C (infraestrutura) sem alterar código.

### D7 — Caracterização: campos dinâmicos
1. **Situação atual:** shape fixo (`ObraCaracterizacao`), somente leitura.
2. **Problema:** obra não-residencial não representável; duplicada em 3 lugares.
3. **Alternativa A (recomendada):** campos dinâmicos por tipo de obra.
4. **Alternativa B:** manter shape fixo.
5. **Recomendação:** A.
6. **Motivo:** desacopla do edifício residencial; elimina duplicação.
7. **Impacto futuro:** habilita tipos de obra variados.

### D8 — EAP: por obra + validação desacoplada
1. **Situação atual:** fixa em código; `validateEap` depende da obra-modelo.
2. **Problema:** bloqueia EAP de outra obra.
3. **Alternativa A (recomendada):** EAP por obra; validação contra a própria obra.
4. **Alternativa B:** manter fixa.
5. **Recomendação:** A.
6. **Motivo:** infraestrutura já suporta (`eaps: Record<string, ObraEap>`).
7. **Impacto futuro:** destrava cadastro de obra diferente.

### D9 — Data de início vinculada à obra
1. **Situação atual:** `DATA_INICIO_OBRA` fixa (05/01/2026).
2. **Problema:** todas as obras usam a mesma data.
3. **Alternativa A (recomendada):** usar `obra.dataInicio` como base do cronograma.
4. **Alternativa B:** manter constante.
5. **Recomendação:** A.
6. **Motivo:** data é metadado do cadastro; cronograma deriva dela.
7. **Impacto futuro:** cada obra tem seu próprio início.

---

## 18. PRESERVAR (obrigatório)

| Item | Evidência | Por quê |
|------|-----------|---------|
| EAP real de 81 nós | `obra-eap-data.ts` | Fonte oficial; não alterar |
| `OBRA-MODELO-EAP-001` | `obra-repository.ts`/`obra-eap-data.ts` | Obra de referência |
| Isolamento ARES/Piemarta | `obra-ares-referencia.ts` | Dataset de referência; não consumido pela obra real |
| FASES 21 e 22 | `obra-modules.ts`, `obra-shell-route.tsx` | Navegação por fase + catálogo declarativo |
| Arquitetura de derivação correta | `obra-planejamento-data.ts`, `obra-lob-data.ts` | Calculadora correta |
| LOB como calculadora | `obra-lob-data.ts` → `domains/linha-de-balanco` | Nunca fonte |
| Ausência de múltiplas fontes de verdade | `obra-repository.ts`, `obra-eap-repository.ts` | Fonte única por repositório |
| Capacidades genéricas neutras | `domains/planejamento`, `servicos`, `linha-de-balanco` | Reutilizáveis |

---

## 19. PRÓXIMA ETAPA PROPOSTA

> **NÃO EXECUTAR.** Apenas proposta do que deveria ser feito depois desta modelagem.

1. **Aprovar esta especificação** (decisões D1–D9).
2. **Fase P0 (desacoplamento, sem reescrita):**
   - Remover `validateEap.foraDaObra` (validar contra a própria obra).
   - Vincular `DATA_INICIO_OBRA` ao `obra.dataInicio`.
   - Desacoplar `OBRA_SCOPE_REF` para cadastro de serviço por obra.
3. **Fase P1 (núcleo operacional):**
   - Criar entidades Disciplina, Frente, Local, Serviço por obra.
   - Criar entidade de registro de Produção (realizado).
4. **Fase P2 (evolução):**
   - Caracterização dinâmica por tipo de obra.
   - Planejamento editável (baseline + overrides, rede, calendário).
5. **Fase P3 (posterior):** Equipes, Recursos, Calendários, tipos de atividade, status custom.
6. **Agente Planejador:** somente após o modelo estruturado estar estável (leitura + propostas).

Cada fase deve ser validada com testes (`evals/specs/**/*.test.ts`) e preservar a obra-modelo
funcionando via seed.

---

## Verificação do documento

- [x] Arquivo existe: `docs/features/modelo-canonico-planejamento.md`
- [x] Somente análise e arquitetura — nenhum código alterado
- [x] EAP real de 81 nós preservada (não alterada)
- [x] LOB como calculadora (não alterada)
- [x] Planejamento/Produção não alterados
- [x] Nenhum commit, nenhuma funcionalidade nova
- [x] Conclusões validadas contra o código real; `NÃO VERIFICADO` onde faltou prova

---

**MODELO CANÔNICO DE PLANEJAMENTO — AGUARDANDO APROVAÇÃO**
