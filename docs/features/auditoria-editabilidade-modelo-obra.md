# Auditoria Profunda — Editabilidade, Configurabilidade e Rigidez do Modelo de Obra

> **Status: AUDITORIA (somente leitura — nenhum código funcional alterado).**
> Data: 2026-09-03 · Domínio: Engenharia · Obra de referência: `OBRA-MODELO-EAP-001`
> Escopo: mapear o que é fixo/derivado/configurável/editável/somente-leitura e responder
> **"Se amanhã eu cadastrar uma obra completamente diferente, consigo configurar o sistema sem alterar código?"**
>
> **Regra de evidência:** cada conclusão cita os arquivos/tipos/funções analisados.
> Conclusões que não puderem ser comprovadas pelo código atual são marcadas como `NÃO VERIFICADO`.

---

## 1. Objetivo e pergunta central da auditoria

### Objetivo
Auditar, **sem alterar código**, o modelo de Obra do domínio Engenharia para mapear:
1. O que é **fixo** (hardcoded em código).
2. O que é **derivado** (calculado a partir de outra fonte).
3. O que é **configurável** (dado por obra, editável via UI).
4. O que é **somente leitura** (exibido, nunca editado).
5. O que é **fonte de verdade** (origem dos dados) vs **fonte duplicada/concorrente**.
6. As **dependências da obra-modelo** (`OBRA-MODELO-EAP-001`).
7. A **arquitetura conceitual** necessária para suportar múltiplas obras diferentes.

### Pergunta central
> **"Se amanhã eu cadastrar uma obra completamente diferente, consigo configurar o sistema sem precisar alterar código?"**

### Método
- Leitura integral dos arquivos do domínio `engenharia/obra/` + capacidades genéricas (`planejamento`, `servicos`, `linha-de-balanco`).
- Busca de padrões hardcoded (`OBRA_MODELO_ID`, `OBRA_MODELO_EAP_ID`, `OBRA_SCOPE_REF`, `DATA_INICIO_OBRA`, `STATUS_OPTIONS`, `CAMPOS_CARACTERIZACAO`, `torres/lajes/subsolos`).
- Classificação de cada dado em: **ESTRUTURAL / EDITÁVEL / CONFIGURÁVEL / DERIVADO / CALCULADO / SOMENTE LEITURA**.
- Nenhuma alteração de código, refatoração ou implementação.

---

## 2. Diagnóstico geral do estado atual

### O que está bem (a preservar)
- **Fonte única de verdade por repositório** — `obra-repository.ts` (obras) e `obra-eap-repository.ts` (EAP por obraId). A UI nunca toca em `localStorage` (arquitetura UI → repository → storage).
- **Derivação correta** — EAP → planejamento → LOB/serviços/produção são **calculados**, nunca duplicados.
- **Capacidades genéricas reutilizáveis** — `domains/planejamento`, `domains/servicos`, `domains/linha-de-balanco` são neutras, sem conceito de Obra.
- **Adapters** traduzem o domínio para os contratos genéricos — bom padrão.
- **Separação ARES/Piemarta** isolada em `obra-ares-referencia.ts`, **não consumida** pela obra real.
- **Catálogo declarativo de módulos** — `obra-modules.ts` (adicionar módulo = 1 entrada + 1 render no shell).
- **EAP real de 81 nós** preservada integralmente; resumo sempre derivado (`deriveEapSummary`).
- **Referência reutilizável de EAP** — `obra-eap-reference.ts` aponta para a origem sem duplicar.

### O que está rígido (o problema)
1. **EAP é fixa em código** — `obra-eap-data.ts` hardcoda 81 nós com `obraId: OBRA_MODELO_EAP_ID`. Não há UI para criar/editar EAP de outra obra.
2. **Escopo é fixo em código** — `OBRA_SCOPE_REF` é um mapa hardcoded por WBS com `{unidade, quantidade, produtividade}`. Sem ele, não há duração → não há planejamento/LOB/serviços/produção.
3. **Data de início é fixa** — `DATA_INICIO_OBRA = new Date(2026, 0, 5)`.
4. **Caracterização tem shape fixo** — torres/lajes/aptos/subsolos/sistema construtivo (específico de edifício residencial).
5. **Disciplinas e Frentes são derivadas, não entidades** — não há cadastro/configuração por obra.
6. **Serviços são derivados, não cadastráveis** — não há cadastro/edição.
7. **Produção é derivada/simulada, não registrada** — não há registro de produção real.
8. **Planejamento é derivado, não editável** — não há edição de datas/durações/predecessoras.
9. **Validação EAP depende da obra-modelo** — `validateEap` marca como inválido qualquer nó cujo `obraId !== OBRA_MODELO_EAP_ID`.
10. **Status é union fixa** — não há status configuráveis por obra.

---

## 3. Resposta objetiva: uma nova obra pode ser configurada sem alterar código?

> **NÃO.**

Uma obra nova pode ser **criada** (nome/status/datas/localização/responsável) e **aberta**, mas **não pode ser configurada** para representar uma obra diferente da obra-modelo:

| Capacidade | Funciona hoje? | Evidência |
|-----------|:---:|-----------|
| Criar obra (identificação) | ✅ | `obra-repository.ts` → `createObra`; `obra-nova.tsx` |
| Abrir obra (contexto) | ✅ | `obra-shell-route.tsx` → `setActiveObra` |
| EAP própria da nova obra | ❌ | `obra-eap-data.ts` → 81 nós com `obraId: OBRA_MODELO_EAP_ID`; seed só contém a obra-modelo |
| Escopo (qtd/prod) da nova obra | ❌ | `OBRA_SCOPE_REF` em `obra-planejamento-data.ts` → mapa hardcoded por WBS |
| Data de início da nova obra | ❌ | `DATA_INICIO_OBRA` fixa em 05/01/2026 |
| Caracterização da nova obra | ❌ | `ObraCaracterizacao` shape fixo (torres/lajes/aptos/subsolos) |
| Disciplinas/Frentes da nova obra | ❌ | Derivadas do EAP nível 1; sem entidade |
| Serviços da nova obra | ❌ | Derivados dos nós TRABALHO; sem cadastro |
| Produção da nova obra | ❌ | Derivada/simulada; sem registro real |
| Planejamento da nova obra | ❌ | Derivado deterministicamente; sem edição |
| LOB da nova obra | ❌ | Derivada do planejamento (herda a rigidez da fonte) |

**Conclusão:** a arquitetura de **derivação** está correta, mas a **fonte de dados** (EAP + escopo + caracterização + data) está **fixa em código** e **específica da obra-modelo**. Para cadastrar uma obra diferente, é preciso **editar código**.

---

## 4. Mapa completo de rigidez do sistema

| Camada | Rigidez | Onde | Impacto |
|--------|---------|------|---------|
| **EAP** | ALTA — fixa em código | `obra-eap-data.ts` | Nova obra não tem EAP própria |
| **Escopo (qtd/prod)** | ALTA — fixa em código | `OBRA_SCOPE_REF` em `obra-planejamento-data.ts` | Sem escopo, sem duração/planejamento |
| **Data de início** | ALTA — fixa | `DATA_INICIO_OBRA` em `obra-planejamento-data.ts` | Todas as obras usam 05/01/2026 |
| **Caracterização** | MÉDIA-ALTA — shape fixo | `ObraCaracterizacao` em `obra-types.ts` | Não representa obra não-residencial |
| **Disciplinas** | ALTA — derivada, sem entidade | `obra-disciplinas.tsx` | Não pode crescer/reduzir/ordenar |
| **Frentes** | ALTA — derivada, sem entidade | `obra-frentes.tsx` | Não pode criar/editar/encerrar |
| **Serviços** | ALTA — derivado, sem cadastro | `obra-servicos-adapter.ts` | Não pode cadastrar/editar |
| **Produção** | ALTA — derivada/simulada | `obra-producao.tsx` | Não registra produção real |
| **Planejamento** | ALTA — derivado, sem edição | `obra-planejamento-data.ts` | Não evolui cronograma |
| **LOB** | BAIXA — derivada corretamente | `obra-lob-data.ts` | Representação/calculadora (correto) |
| **Status** | MÉDIA — union fixa | `ObraStatus` em `obra-types.ts` | Não configura status por obra |
| **Módulos** | BAIXA — catálogo declarativo | `obra-modules.ts` | Adicionar módulo = 1 entrada + 1 render |
| **Validação EAP** | ALTA — depende da obra-modelo | `validateEap` em `obra-eap-repository.ts` | Bloqueia EAP de outra obra |

---

## 5. Matriz de editabilidade

### 5.1 Obra (entidade raiz)

| Campo | Tipo | Classificação | Editável via UI? | Evidência |
|-------|------|---------------|:---:|-----------|
| `id` | string | **ESTRUTURAL / SOMENTE LEITURA** | ❌ | `obra-types.ts`; `createObraId` em `obra-repository.ts` |
| `nome` | string | **EDITÁVEL** | ✅ | `obra-editar.tsx` |
| `status` | `ObraStatus` | **EDITÁVEL** (union fixa) | ✅ (valores fixos) | `obra-editar.tsx` → `STATUS_OPTIONS` |
| `dataInicio?` | string | **EDITÁVEL** (metadado cadastro) | ✅ | `obra-editar.tsx` |
| `dataFim?` | string | **EDITÁVEL** (metadado cadastro) | ✅ | `obra-editar.tsx` |
| `localizacao?` | string | **EDITÁVEL** | ✅ | `obra-editar.tsx` |
| `responsavel?` | string | **EDITÁVEL** | ✅ | `obra-editar.tsx` |
| `arquivada?` | boolean | **EDITÁVEL** (soft-delete) | ✅ | `obra-lista.tsx` → `archiveObra`/`unarchiveObra` |
| `caracterizacao?` | `ObraCaracterizacao` | **CONFIGURÁVEL** (shape fixo) | ❌ (somente leitura) | `obra-caracterizacao.tsx`; `obra-visao-geral.tsx` |
| `eap?` | `ObraEapSummary` | **DERIVADO** | ❌ | `obra-eap-repository.ts` → `deriveEapSummary` |

### 5.2 Status

| Valor | Classificação | Evidência |
|-------|---------------|-----------|
| `PROPOSTA` | Union fixa | `obra-types.ts` → `ObraStatus` |
| `PLANEJAMENTO` | Union fixa | idem |
| `EM_EXECUCAO` | Union fixa | idem |
| `CONCLUIDA` | Union fixa | idem |
| `ARQUIVADA` | **DERIVADO** de `arquivada` | `obra-repository.ts` → `statusEfetivo` |

**Rigidez:** não há como configurar status custom por obra/tipo de obra.

### 5.3 Datas
- `dataInicio`/`dataFim` são **metadados do cadastro** (editáveis) — `obra-editar.tsx`.
- `DATA_INICIO_OBRA` (planejamento) é **fixa em código** — `obra-planejamento-data.ts:13`.
- **Não vinculada** ao `obra.dataInicio` (o comentário em `obra-types.ts:54-59` confirma que `dataInicio` é metadado do cadastro e NÃO é sobrescrito pelo planejamento).

### 5.4 Suporte a múltiplas obras
- O repositório é uma **lista** (`obras: Obra[]`) — `obra-repository.ts`.
- `obra-eap-repository` é um **mapa por obraId** (`eaps: Record<string, ObraEap>`) — `obra-eap-repository.ts:172`.
- **PORÉM:** o seed só contém a obra-modelo; não há UI para criar EAP/escopo de outra obra. **A infraestrutura suporta, mas o produto não expõe.**

---

## 6. Inventário de dados hardcoded

| # | Dado | Arquivo | Origem atual | Deveria ser | Risco |
|---|------|---------|--------------|-------------|-------|
| 1 | 81 nós EAP | `obra-eap-data.ts` | Obra-modelo (fonte oficial) | Dado por obra (cadastro/importação) | **ALTO** |
| 2 | `OBRA_SCOPE_REF` (qtd/prod por WBS) | `obra-planejamento-data.ts` | Obra-modelo | Dado por obra (cadastro) | **ALTO** |
| 3 | `DATA_INICIO_OBRA` (05/01/2026) | `obra-planejamento-data.ts` | Obra-modelo | Dado por obra (`obra.dataInicio`) | **ALTO** |
| 4 | Caracterização (torres/lajes/aptos/subsolos) | `obra-types.ts` + seeds | Obra-modelo | Configurável por tipo de obra | **MÉDIO-ALTO** |
| 5 | `validateEap.foraDaObra` (obraId fixo) | `obra-eap-repository.ts` | Obra-modelo | Validar contra a própria obra | **ALTO** |
| 6 | `OBRA_MODELO_ID`/`OBRA_MODELO_EAP_ID` | `obra-repository.ts`/`obra-eap-data.ts` | Obra-modelo | Referência (não fonte operacional) | **MÉDIO** |
| 7 | `REF_EAP_RES_001` | `obra-eap-reference.ts` | Obra-modelo | Biblioteca de referências | **BAIXO** |
| 8 | ARES/Piemarta (15 atv, 18 elos, 11 serv) | `obra-ares-referencia.ts` | Dataset de referência | Isolado (não consumido pela obra real) | **BAIXO** |
| 9 | `STATUS_OPTIONS` (lista/editar/nova) | `obra-lista.tsx`/`obra-editar.tsx`/`obra-nova.tsx` | Union fixa | Configurável | **BAIXO** |
| 10 | `CAMPOS_CARACTERIZACAO` | `obra-caracterizacao.tsx`/`obra-visao-geral.tsx` | Shape fixo | Configurável | **MÉDIO** |
| 11 | `OBRA_MODULES` (11 módulos) | `obra-modules.ts` | Catálogo declarativo | Catálogo (ok) | **BAIXO** |
| 12 | `OBRA_FASES_ORDER` | `obra-modules.ts` | Fixo | Fixo (ok) | **BAIXO** |

---

## 7. Arquivos onde cada dado hardcoded está localizado

| Dado | Arquivo(s) | Linha(s) relevante(s) |
|------|-----------|----------------------|
| 81 nós EAP | `obra-eap-data.ts` | `OBRA_MODELO_EAP_NODES` (linha 18+); `OBRA_MODELO_EAP_ID` (linha 15) |
| Escopo (qtd/prod) | `obra-planejamento-data.ts` | `OBRA_SCOPE_REF` (linha 23–115) |
| Data de início | `obra-planejamento-data.ts` | `DATA_INICIO_OBRA` (linha 13) |
| Caracterização (seed) | `obra-repository.ts` | `OBRA_MODELO.caracterizacao` (linha 34–40) |
| Caracterização (metadata EAP) | `obra-eap-data.ts` | metadata (linha 163–168) |
| Caracterização (referência) | `obra-eap-reference.ts` | `REF_EAP_RES_001.caracterizacao` (linha 22–31) |
| Caracterização (shape) | `obra-types.ts` | `ObraCaracterizacao` (linha 41–47) |
| Caracterização (UI) | `obra-caracterizacao.tsx` / `obra-visao-geral.tsx` | `CAMPOS_CARACTERIZACAO` |
| Validação obra-modelo | `obra-eap-repository.ts` | `validateEap.foraDaObra` (linha 146–148) |
| Status options | `obra-lista.tsx` / `obra-editar.tsx` / `obra-nova.tsx` | `STATUS_OPTIONS` |
| Status tone | `obra-lista.tsx` | `STATUS_TONE` (linha 28–34) |
| Módulos | `obra-modules.ts` | `OBRA_MODULES` (linha 32–47) |
| Renderers | `obra-shell-route.tsx` | `MODULE_RENDERERS` (linha 29–51) |
| ARES/Piemarta | `obra-ares-referencia.ts` | `ARES_ATIVIDADES_REFERENCIA`, `ARES_REDE_REFERENCIA`, `ARES_SERVICOS_LOB_REFERENCIA` |

---

## 8. Fonte atual de cada informação

| Informação | Fonte atual | Arquivo |
|-----------|-------------|---------|
| Obras | `useObraRepository` (lista) | `obra-repository.ts` |
| EAP | `useObraEapRepository` (mapa por obraId) | `obra-eap-repository.ts` + `obra-eap-data.ts` |
| Escopo (qtd/prod) | `OBRA_SCOPE_REF` (hardcoded) | `obra-planejamento-data.ts` |
| Data de início do cronograma | `DATA_INICIO_OBRA` (hardcoded) | `obra-planejamento-data.ts` |
| Caracterização | `Obra.caracterizacao` (shape fixo) | `obra-types.ts` + seeds |
| Disciplinas | Derivada do EAP nível 1 | `obra-disciplinas.tsx` |
| Frentes | Derivada do EAP nível 1 | `obra-frentes.tsx` |
| Serviços | Derivada dos nós TRABALHO + planejamento | `obra-servicos-adapter.ts` |
| Produção | Derivada do planejamento + `OBRA_SCOPE_REF` | `obra-producao.tsx` |
| Planejamento | Derivada do EAP + `OBRA_SCOPE_REF` + `DATA_INICIO_OBRA` | `obra-planejamento-data.ts` |
| LOB | Derivada do planejamento | `obra-lob-data.ts` |
| Módulos | `OBRA_MODULES` (catálogo) | `obra-modules.ts` |
| Status | `ObraStatus` (union fixa) | `obra-types.ts` |

---

## 9. Fonte de verdade recomendada

| Informação | Fonte de verdade recomendada | Justificativa |
|-----------|------------------------------|---------------|
| Obras | `obra-repository.ts` (lista) | Já é fonte única ✅ |
| EAP | `obra-eap-repository.ts` (mapa por obraId) | Já é fonte única ✅; falta expor UI |
| Escopo (qtd/prod) | **Por obra** (cadastro de serviço) | Desacoplar de `OBRA_SCOPE_REF` global |
| Data de início | **`obra.dataInicio`** (metadado cadastro) | Vincular ao cadastro, não a constante |
| Caracterização | **Por obra** (configurável por tipo) | Desacoplar do shape fixo |
| Disciplinas | **Entidade por obra** | Não derivar do EAP |
| Frentes | **Entidade por obra** | Não derivar do EAP |
| Serviços | **Cadastro por obra** (EAP × frente × local) | Não derivar dos nós TRABALHO |
| Produção | **Registro por obra** (realizado) | Não derivar/simular |
| Planejamento | **Baseline derivado + overrides editáveis** | Evoluir cronograma |
| LOB | **Derivada do planejamento** (calculadora) | Já é derivada ✅ |
| Módulos | `obra-modules.ts` (catálogo) | Já é fonte única ✅ |

---

## 10. Possíveis duplicidades / fontes de verdade concorrentes

| Dado | Duplicado em | Risco |
|------|--------------|-------|
| Caracterização (torres/lajes) | `obra-repository.ts` (seed) + `obra-eap-data.ts` (metadata) + `obra-eap-reference.ts` (caracterizacao) | **MÉDIO** — 3 lugares com os mesmos números (1 torre, 14 lajes) |
| Status options | `obra-lista.tsx` + `obra-editar.tsx` + `obra-nova.tsx` | **BAIXO** — UI, mas duplicado |
| Campos caracterização | `obra-caracterizacao.tsx` + `obra-visao-geral.tsx` | **BAIXO** — UI, mas duplicado |
| `DATA_INICIO_OBRA` | `obra-planejamento-data.ts` + `obra-lob-data.ts` (re-export) | **BAIXO** — re-export, não duplicação |

**Nota:** a caracterização aparece em 3 lugares (seed da obra, metadata da EAP, referência). Isso é **duplicação de fato** — os números (1 torre, 14 lajes) estão repetidos. Deveria haver uma única fonte (a obra) e os demais deveriam referenciar ou derivar.

---

## 11. Dependências da `OBRA-MODELO-EAP-001`

| Dependência | Onde | Efeito |
|-------------|------|--------|
| EAP de 81 nós | `obra-eap-data.ts` | Nova obra sem EAP própria |
| `OBRA_SCOPE_REF` por WBS | `obra-planejamento-data.ts` | Nova obra sem escopo → sem duração |
| `DATA_INICIO_OBRA` | `obra-planejamento-data.ts` | Nova obra usa data fixa |
| `validateEap.foraDaObra` | `obra-eap-repository.ts` | Nova obra com EAP própria é "inválida" |
| Caracterização shape | `obra-types.ts` | Nova obra não-residencial não representável |
| `REF_EAP_RES_001` | `obra-eap-reference.ts` | Referência aponta para a obra-modelo (ok, mas única) |

**Conclusão:** qualquer obra nova que não seja um edifício residencial de 1 torre/14 lajes **não pode ser representada** sem alterar código.

---

## 12. Auditoria completa do EAP

### Estado atual
- `obra-eap-data.ts` hardcoda **81 nós** com `obraId: OBRA_MODELO_EAP_ID` (10 disciplinas / 24 pacotes / 47 trabalhos).
- `obra-eap-repository.ts` seed: `{ [OBRA_MODELO_EAP_ID]: OBRA_MODELO_EAP }` (linha 179–181).
- `setEap(eap)` permite registrar EAP de outra obra **programaticamente** (linha 185–188), mas **não há UI**.
- `validateEap` tem `foraDaObra` que marca como inválido qualquer nó cujo `obraId !== OBRA_MODELO_EAP_ID` (linha 146–148).

### O EAP é modelo estrutural reutilizável ou estrutura fixa do produto?
**Hoje é estrutura fixa do produto** (da obra-modelo), embora a **intenção** (documentada em `obra-eap-reference.ts`) seja de modelo reutilizável. A referência `REF_EAP_RES_001` existe e aponta para a origem, mas **não há mecanismo para instanciar uma EAP de referência numa nova obra**.

### Capacidades de edição (todas AUSENTES hoje)

| Operação | Existe? | Onde estaria |
|----------|:---:|--------------|
| Criar disciplina | ❌ | — |
| Editar disciplina | ❌ | — |
| Excluir/arquivar disciplina | ❌ | — |
| Criar subdisciplina | ❌ | — |
| Criar serviço | ❌ | — |
| Alterar hierarquia | ❌ | — |
| Mover nó | ❌ | — |
| Editar código/WBS | ❌ | — |
| Ordenar | ❌ | — |
| Expandir (adicionar nó) | ❌ | — |
| Nós folha | ❌ | — |
| Dependências | ❌ | — |

### Como permitir EAPs diferentes sem quebrar a arquitetura
A arquitetura **já suporta** EAP por obraId (`eaps: Record<string, ObraEap>`). O que falta:
1. **Remover a dependência da obra-modelo na validação** (`validateEap.foraDaObra`).
2. **Expor UI de criação/edição de EAP** (ou importação de referência → instância).
3. **Vincular o escopo (qtd/prod) à EAP da obra**, não a um mapa global por WBS.

---

## 13. Auditoria de Disciplinas

### Estado atual
- `obra-disciplinas.tsx` **deriva** as disciplinas dos nós nível 1 da EAP (`nodes.filter((n) => n.nivel === 1)`).
- Não há entidade/configuração de disciplina por obra.

### Análise conceitual: `Disciplina → EAP` vs `EAP → Disciplina`
- **Hoje:** `EAP → Disciplina` (disciplina = nó nível 1 da EAP).
- **Conceitualmente correto para o domínio:** a **Disciplina é a fonte de verdade** (especialidade/área do conhecimento), e a **EAP é a decomposição de entregáveis** que **referencia** disciplinas. Ou seja, o correto é `Disciplina → EAP` (a disciplina existe primeiro; os nós da EAP são associados a ela).
- **Por quê:** uma disciplina (ex.: "Estrutura") pode ter múltiplos pacotes/trabalhos na EAP, mas também pode existir sem EAP (ex.: disciplina planejada, ainda sem decomposição). Derivar disciplina do EAP impede ter disciplina sem EAP e impede configurar cor/ícone/ordem/código independentes.

### Proposta (não implementar)
- Criar **entidade/configuração de disciplinas por obra** (`Disciplina` com `{id, codigo, nome, ordem, cor?, icone?, arquivada?}`).
- Permitir: adicionar, editar, arquivar, reativar, ordenar, definir código/nome, configurar cor/ícone.
- **Associar elementos do EAP** a disciplinas (nó nível 1 referencia a disciplina, ou a disciplina referencia os WBS).
- **Migração:** para a obra-modelo, as 10 disciplinas atuais (nível 1 da EAP) viram o seed de disciplinas.

---

## 14. Auditoria de Frentes

### Estado atual
- `obra-frentes.tsx` **deriva** as frentes das disciplinas raiz da EAP (`nodes.filter((n) => n.nivel === 1)`).
- Frente = natureza/especialidade do trabalho (documentado no código).

### Classificação
- **Hoje:** derivação do EAP (frente = disciplina raiz).
- **Deveria ser:** **entidade operacional** (cadastro/configuração), pois uma frente tem ciclo de vida próprio (criar, editar, encerrar) e atributos operacionais que não vêm do EAP.

### Atributos propostos (somente os com justificativa)

| Atributo | Justificativa | Deveria ser |
|----------|---------------|-------------|
| `nome` | Identificação | **EDITÁVEL** |
| `codigo` | Referência operacional | **EDITÁVEL** |
| `disciplina` | Vínculo à disciplina | **EDITÁVEL** (referência) |
| `responsavel` | Gestão da frente | **EDITÁVEL** |
| `equipe` | Composição da frente | **EDITÁVEL** |
| `status` | Ciclo de vida (ativa/encerrada) | **EDITÁVEL** |
| `localizacao` | Onde atua | **EDITÁVEL** |
| `capacidade` | Planejamento de recursos | **EDITÁVEL** (opcional) |
| `produtividade` | Base de cálculo | **EDITÁVEL** (opcional) |
| `inicio`/`término` | Período de atuação | **EDITÁVEL** |
| `observacoes` | Notas | **EDITÁVEL** |

**Nota:** nem todos precisam existir agora. `capacidade`/`produtividade` podem ficar para depois. O essencial é `nome`, `codigo`, `disciplina`, `status`, `responsavel`, `equipe`.

---

## 15. Auditoria de Serviços

### Estado atual
- `obra-servicos-adapter.ts` **deriva** os serviços dos nós TRABALHO (nível 3) da EAP + planejamento.
- `ServicoItem` tem `{id, codigo, nome, duracao, inicio, fim, status}` + campos opcionais preparados (`unidade`, `quantidade`, `produtividade`, `predecessora`).

### Conceito `SERVIÇO = EAP × FRENTE × LOCALIZAÇÃO`
- **Hoje NÃO está representado.** O serviço é apenas um nó TRABALHO da EAP com datas derivadas. **Não há dimensão de frente nem de localização** no serviço.
- O conceito correto (presente no dataset ARES, mas não na obra real) é que um serviço é a **interseção** de um elemento de escopo (EAP), uma frente (quem executa) e uma localização (onde). Isso permite, por exemplo, "Alvenaria interna — Frente 3 — Torre A, pavimentos 1-7".

### O que identifica um serviço
- **Hoje:** o WBS do nó TRABALHO.
- **Deveria ser:** uma identidade composta (ex.: `obraId + eapWbs + frenteId + localizacaoId`), pois o mesmo trabalho pode ocorrer em múltiplas frentes/locais.

### O que pode ser editado vs derivado

| Dado | Pertence a | Editável? |
|------|-----------|-----------|
| `quantidade` | **Cadastro/base** (escopo) | **EDITÁVEL** |
| `unidade` | **Cadastro/base** | **EDITÁVEL** |
| `produtividade` | **Cadastro/base** (referência) | **EDITÁVEL** |
| `predecessora` | **Cadastro/base** (rede) | **EDITÁVEL** |
| `duracao` | **DERIVADO** (qtd / produtividade) | Calculado |
| `inicio`/`fim` | **DERIVADO** (cronograma) | Calculado |
| `localizacao` | **Cadastro** (dimensão) | **EDITÁVEL** |
| `frente` | **Cadastro** (dimensão) | **EDITÁVEL** |
| `disciplina` | **Cadastro** (dimensão) | **EDITÁVEL** |

---

## 16. Auditoria de Produção

### Estado atual
- `obra-producao.tsx` **deriva** a produção dos nós TRABALHO com duração + `OBRA_SCOPE_REF`.
- Mostra: WBS, serviço, un, qtd planejada, ritmo, início, fim, e **"Pendente"** para produção real.

### Classificação
- **Hoje:** **derivada/simulada** — a produção é calculada do EAP + escopo, e a produção real é marcada como "Pendente" (não registrada).
- **Problema:** o sistema **não registra produção real** — trata produção como se fosse um valor calculado do EAP. Isso é **incorreto** para gestão real.

### Separação necessária

| Categoria | Dados | Editável? |
|-----------|-------|-----------|
| **Planejado** | quantidade planejada, produtividade planejada, ritmo, meta, período | **EDITÁVEL** (cadastro) |
| **Realizado** | quantidade produzida, data, equipe, frente, responsável, observação | **EDITÁVEL** (registro) |
| **Derivado** | avanço, produtividade real, desvio, projeção, tendência | **CALCULADO** |

**Conclusão:** Produção precisa de uma **entidade de registro de produção real** (apontamentos diários/periódicos), separada do planejado. O avanço/desvio/projeção são **derivados** da comparação planejado × realizado.

---

## 17. Auditoria de Planejamento

### Estado atual
- `obra-planejamento-data.ts` **deriva** o cronograma dos nós EAP + `OBRA_SCOPE_REF` + `DATA_INICIO_OBRA`.
- `derivarPlanejamento` sequencia por disciplina, calcula duração (qtd/prod), datas acumuladas, crítico (limiar 60%), predecessora (sequencial).
- **Não há edição** — tudo é derivado deterministicamente.

### Cadastrado/Editável vs Derivado/Calculado

| Elemento | Deveria ser | Observação |
|----------|-------------|------------|
| `atividade` | **CADASTRADA** | Nome/escopo |
| `duracao` | **DERIVADA** (qtd/prod) OU **EDITÁVEL** (override) | Pode ser calculada ou manual |
| `inicio` | **DERIVADO** (cronograma) | Calculado |
| `término` | **DERIVADO** | Calculado |
| `predecessoras` | **CADASTRADAS** | Rede de precedência |
| `calendário` | **CONFIGURÁVEL** | Dias úteis/feriados |
| `percentual planejado` | **DERIVADO** | Curva S |
| `percentual realizado` | **CADASTRADO** | Vem da produção real |
| `status` | **DERIVADO** (datas × realizado) | Calculado |
| `tipo de atividade` | **CONFIGURÁVEL** | Marco/tarefa/duração |
| `marcos` | **CADASTRADOS** | |
| `restrições` | **CADASTRADAS** | |

**Conclusão:** o planejamento atual é **excessivamente dependente de dados de referência** (escopo hardcoded). Para evoluir o cronograma real, é preciso permitir **cadastro de atividades, rede de precedência, calendário e overrides de duração**, mantendo a derivação como ponto de partida (baseline).

---

## 18. Auditoria da Linha de Balanço

### Estado atual
- `obra-lob-data.ts` **deriva** a grade LOB dos nós EAP + planejamento.
- `domains/linha-de-balanco/lob-data.ts` é a **capacidade genérica** (calculadora pura).

### Confirmação
- **A LOB é uma representação/calculadora derivada dos dados operacionais** (planejamento), **NÃO uma segunda fonte de dados.** ✅ **Correto.**
- Depende de: planejamento (datas/durações), serviço (linhas), localização (eixo temporal), produtividade (via duração).
- **Nenhum dado é fonte própria na LOB** — tudo vem do adapter.

### O que deveria ser configurável
- **Nada na LOB em si** — ela é derivada. O que precisa ser configurável é a **fonte** (planejamento/serviços), não a LOB.

---

## 19. Auditoria de Locais/Unidades

### Estado atual
- **Não existe entidade de Locais/Unidades** no domínio Obra.
- A caracterização tem `torres`, `lajes`, `apartamentosPorPavimento`, `subsolos` — mas são **números agregados**, não uma estrutura hierárquica de locais.
- O dataset ARES (`obra-ares-referencia.ts`) tem `local: "LOCAL-T1"` e `frente`/`equipe` por atividade, mas **não é consumido pela obra real**.

### Classificação
- **Hoje:** Locais/Unidades **NÃO existem** como entidade. Apenas números agregados na caracterização.
- **Deveria ser:** **entidade hierárquica por obra** (torres → pavimentos → unidades; ou trechos → km para rodoviária).

### Proposta (não implementar)
- Criar **entidade de Locais por obra** (`Local` com `{id, nome, tipo, pai?, ordem}`), hierárquica.
- Permitir: adicionar, editar, arquivar, ordenar, definir hierarquia.
- **Vincular serviços** a locais (dimensão `LOCALIZAÇÃO` do conceito `SERVIÇO = EAP × FRENTE × LOCALIZAÇÃO`).
- **Migração:** para a obra-modelo, os locais seriam derivados da caracterização (1 torre, 14 lajes, 1 apto/pavimento).

---

## 20. Auditoria de Caracterização da Obra

### Estado atual
- `ObraCaracterizacao` em `obra-types.ts` tem shape **fixo**: `{torres, lajes, apartamentosPorPavimento, subsolos, sistemaConstrutivo}`.
- Exibida **somente leitura** em `obra-caracterizacao.tsx` e `obra-visao-geral.tsx` (via `CAMPOS_CARACTERIZACAO`).
- Seed em `obra-repository.ts` (1 torre, 14 lajes, 1 apto/pav, 0 subsolos, concreto armado).

### Classificação
- **Hoje:** shape fixo, somente leitura, específico de edifício residencial.
- **Deveria ser:** **configurável por tipo de obra** (campos dinâmicos). Uma obra rodoviária não tem torres/lajes; tem trechos/km, tipo de pavimento, etc.

### Proposta (não implementar)
- Tornar a caracterização **dinâmica** (lista de campos `{chave, rotulo, tipo, valor}` por obra/tipo de obra).
- Permitir **edição** da caracterização via UI.
- **Migração:** para a obra-modelo, os 5 campos atuais viram o seed de campos.

---

## 21. Auditoria de Recursos/Equipes/Calendários

### Estado atual
- **Não existe entidade de Recursos, Equipes ou Calendários** no domínio Obra.
- O dataset ARES (`obra-ares-referencia.ts`) tem `equipe: "EQUIPE-001"` por atividade, mas **não é consumido pela obra real**.
- O planejamento (`obra-planejamento-data.ts`) **não considera calendário** — datas são dias corridos acumulados a partir de `DATA_INICIO_OBRA`.

### Classificação
- **Hoje:** Recursos/Equipes/Calendários **NÃO existem** como entidade.
- **Deveria ser:** **entidades por obra** (fases futuras).

### Proposta (não implementar)
- **Equipes:** entidade por obra (`{id, nome, frenteId?, responsavel?, membros?}`).
- **Recursos:** entidade por obra (`{id, nome, tipo, unidade, custo?}`).
- **Calendários:** entidade por obra (`{id, nome, diasUteis, feriados}`), usada no cálculo de datas do planejamento.

---

## 22. Arquitetura conceitual recomendada para suportar múltiplas obras diferentes

### Princípio central
> **A Obra é a raiz de um grafo de dados configuráveis. Cada obra tem seu próprio EAP, escopo, disciplinas, frentes, serviços, locais, planejamento e produção. Nada é global/hardcoded.**

### Modelo proposto (conceitual)

```
Obra
 ├── Caracterização (configurável por tipo de obra — campos dinâmicos)
 ├── Disciplinas (entidade por obra: codigo, nome, ordem, cor, icone, arquivada)
 ├── EAP (por obra: nós com wbs, nome, nivel, tipo, pai, ordem, disciplinaId)
 ├── Locais (entidade por obra: torres, pavimentos, blocos, trechos — hierárquico)
 ├── Frentes (entidade por obra: nome, codigo, disciplinaId, responsavel, equipe, status)
 ├── Serviços (cadastro: eapWbs × frenteId × localId, quantidade, unidade, produtividade, predecessora)
 ├── Planejamento (atividades: serviçoId, duracao/override, datas, rede, calendario, marcos)
 ├── Produção (registro: serviçoId, data, quantidade, equipe, frente, responsavel, observacao)
 └── LOB (DERIVADA do planejamento — calculadora, nunca fonte)
```

### Como suportar Obra A / B / C sem alterar código

| Obra | Torres | Disciplinas | Frentes | Como o sistema representa |
|------|:---:|:---:|:---:|---------------------------|
| **A** (3 torres, 12 disc, 40 frentes) | 3 | 12 | 40 | Locais com 3 torres; 12 disciplinas cadastradas; 40 frentes cadastradas; EAP própria; escopo por serviço |
| **B** (1 torre, 7 disc, 18 frentes) | 1 | 7 | 18 | Mesma estrutura, valores diferentes |
| **C** (rodoviária) | — | diferentes | diferentes | Caracterização dinâmica (sem torres/lajes); locais = trechos/km; disciplinas = terraplenagem/pavimentação/etc.; EAP própria |

**Requisitos para isso:**
1. **Caracterização dinâmica** (campos por tipo de obra, não shape fixo).
2. **EAP por obra** (cadastro/importação de referência → instância).
3. **Escopo por obra** (qtd/prod por serviço, não mapa global).
4. **Disciplinas/Frentes/Locais/Serviços como entidades por obra**.
5. **Planejamento editável** (baseline derivado + overrides).
6. **Produção registrada** (realizado separado do planejado).
7. **Remover dependência da obra-modelo na validação** (`validateEap`).

---

## 23. Classificação das mudanças

### P0 — Obrigatório antes de continuar
| # | Mudança | Justificativa |
|---|---------|---------------|
| P0-1 | Remover dependência da obra-modelo na validação (`validateEap.foraDaObra`) | Bloqueia qualquer obra nova |
| P0-2 | EAP por obra (cadastro/importação) | Sem EAP própria, nada funciona |
| P0-3 | Escopo por obra (qtd/prod por serviço) | Sem escopo, sem duração/planejamento |
| P0-4 | `DATA_INICIO_OBRA` vinculada ao `obra.dataInicio` | Data fixa invalida qualquer obra |

### P1 — Núcleo operacional
| # | Mudança | Justificativa |
|---|---------|---------------|
| P1-1 | Disciplinas como entidade por obra | Crescer/reduzir/ordenar |
| P1-2 | Frentes como entidade operacional | Criar/editar/encerrar |
| P1-3 | Serviços como cadastro (EAP × frente × local) | Conceito correto |
| P1-4 | Produção registrada (realizado) | Gestão real |

### P2 — Evolução
| # | Mudança | Justificativa |
|---|---------|---------------|
| P2-1 | Caracterização dinâmica | Obra não-residencial |
| P2-2 | Planejamento editável (baseline + overrides) | Evolução do cronograma |
| P2-3 | Locais como entidade | Torres/pavimentos/blocos/trechos |

### P3 — Posterior
| # | Mudança | Justificativa |
|---|---------|---------------|
| P3-1 | Equipes | Composição de frentes |
| P3-2 | Recursos | Planejamento de recursos |
| P3-3 | Calendários | Dias úteis/feriados |
| P3-4 | Tipos de atividade | Marco/tarefa/duração |
| P3-5 | Status custom | Configuração por obra |

---

## 24. Riscos de não corrigir cada problema

| Problema | Risco de não corrigir |
|----------|----------------------|
| EAP fixa em código | Impossibilidade de cadastrar obra diferente; sistema preso à obra-modelo |
| Escopo fixo (`OBRA_SCOPE_REF`) | Sem escopo, sem duração/planejamento/LOB/serviços/produção para obra nova |
| Data fixa (`DATA_INICIO_OBRA`) | Todas as obras usam a mesma data de início |
| Caracterização shape fixo | Obra não-residencial não representável |
| Disciplinas/Frentes derivadas | Não podem crescer/reduzir/ordenar; sem ciclo de vida |
| Serviços derivados | Conceito `EAP × FRENTE × LOCALIZAÇÃO` não representado |
| Produção derivada/simulada | Dados fictícios tratados como reais; sem gestão real |
| Planejamento derivado | Cronograma não evolui; sem rede/calendário/overrides |
| Validação obra-modelo | Bloqueia EAP de outra obra, impedindo uso da infraestrutura existente |
| Duplicação de caracterização | 3 lugares com os mesmos números; risco de divergência |
| Status union fixa | Não configura status por obra |

---

## 25. Impacto das mudanças sobre a arquitetura existente

### O que NÃO muda (impacto baixo)
- **Repositórios** (`obra-repository`, `obra-eap-repository`) — já são fonte única por obraId.
- **Capacidades genéricas** (`planejamento`, `servicos`, `linha-de-balanco`) — já são neutras.
- **Adapters** — padrão já existente, apenas ganham novas fontes.
- **Catálogo de módulos** (`obra-modules.ts`) — permanece declarativo.
- **Derivação** (EAP → planejamento → LOB) — permanece como calculadora.

### O que muda (impacto médio)
- **`OBRA_SCOPE_REF`** deixa de ser mapa global e vira dado por obra (cadastro de serviço).
- **`DATA_INICIO_OBRA`** deixa de ser constante e vira `obra.dataInicio`.
- **`validateEap`** deixa de depender de `OBRA_MODELO_EAP_ID`.
- **Caracterização** deixa de ser shape fixo e vira campos dinâmicos.

### O que muda (impacto alto)
- **Disciplinas/Frentes/Locais/Serviços** deixam de ser derivações e viram **entidades por obra**.
- **Produção** ganha **entidade de registro real** (realizado).
- **Planejamento** ganha **edição** (baseline + overrides, rede, calendário).

**Nota:** as mudanças P0 são **desacoplamentos** (remover hardcodes), não reescritas. As mudanças P1/P2/P3 adicionam **entidades novas** sem quebrar as existentes (a obra-modelo continua funcionando via seed).

---

## 26. O que deve ser preservado exatamente como está

| Item | Evidência | Por quê |
|------|-----------|---------|
| EAP real de 81 nós | `obra-eap-data.ts` | Fonte oficial; não alterar |
| Separação ARES/Piemarta | `obra-ares-referencia.ts` | Dataset de referência isolado; não consumido pela obra real |
| Fonte única por repositório | `obra-repository.ts`, `obra-eap-repository.ts` | Arquitetura correta |
| Derivação EAP → planejamento → LOB | `obra-planejamento-data.ts`, `obra-lob-data.ts` | Calculadora correta |
| Capacidades genéricas | `domains/planejamento`, `servicos`, `linha-de-balanco` | Neutras, reutilizáveis |
| Catálogo declarativo de módulos | `obra-modules.ts` | Adicionar módulo = 1 entrada + 1 render |
| `ARQUIVADA` derivado de `arquivada` | `obra-repository.ts` → `statusEfetivo` | Sem segunda fonte |
| `dataInicio` como metadado do cadastro | `obra-types.ts` | Fonte única do cadastro; NÃO sobrescrito pelo planejamento |
| Referência reutilizável de EAP | `obra-eap-reference.ts` | Aponta para origem sem duplicar |

---

## 27. O que deve ser desacoplado

| Item | De | Para | Evidência |
|------|----|------|-----------|
| EAP | `obra-eap-data.ts` (fixa) | Dado por obra | `obra-eap-repository.ts` já suporta `eaps: Record<string, ObraEap>` |
| Escopo | `OBRA_SCOPE_REF` (global) | Dado por obra (cadastro de serviço) | `obra-planejamento-data.ts` |
| Data de início | `DATA_INICIO_OBRA` (constante) | `obra.dataInicio` | `obra-types.ts` |
| Caracterização | Shape fixo | Campos dinâmicos por tipo | `obra-types.ts` |
| Validação | `OBRA_MODELO_EAP_ID` | A própria obra | `obra-eap-repository.ts` → `validateEap` |
| Disciplinas | EAP nível 1 | Entidade por obra | `obra-disciplinas.tsx` |
| Frentes | EAP nível 1 | Entidade por obra | `obra-frentes.tsx` |
| Serviços | Nós TRABALHO | Cadastro por obra | `obra-servicos-adapter.ts` |
| Produção | Derivada/simulada | Registro real | `obra-producao.tsx` |
| Planejamento | Derivado deterministicamente | Baseline + overrides | `obra-planejamento-data.ts` |

---

## 28. O que deve virar entidade

| Entidade | De onde vem hoje | Evidência |
|----------|------------------|-----------|
| **Disciplina** | Derivada do EAP nível 1 | `obra-disciplinas.tsx` |
| **Frente** | Derivada do EAP nível 1 | `obra-frentes.tsx` |
| **Local/Unidade** | Não existe (números agregados) | `obra-types.ts` → `ObraCaracterizacao` |
| **Serviço** | Derivado dos nós TRABALHO | `obra-servicos-adapter.ts` |
| **Produção (realizado)** | Derivada/simulada | `obra-producao.tsx` |
| **Equipe** | Não existe (só no dataset ARES) | `obra-ares-referencia.ts` |
| **Recurso** | Não existe | — |
| **Calendário** | Não existe (dias corridos) | `obra-planejamento-data.ts` |

---

## 29. O que deve permanecer derivado

| Item | Derivado de | Evidência |
|------|-------------|-----------|
| Resumo EAP (`ObraEapSummary`) | Nós reais | `obra-eap-repository.ts` → `deriveEapSummary` |
| Duração de serviço | qtd / produtividade | `obra-planejamento-data.ts` → `calcDuracao` |
| Datas de início/fim | Cronograma | `obra-planejamento-data.ts` → `derivarPlanejamento` |
| Caminho crítico | Durações | `obra-planejamento-data.ts` → `marcarCriticoEPredecessora` |
| LOB | Planejamento | `obra-lob-data.ts` → `derivarGradeLob` |
| `ARQUIVADA` | `arquivada` | `obra-repository.ts` → `statusEfetivo` |
| Avanço/desvio/projeção | Planejado × Realizado | (futuro) |

---

## 30. O que deve ser editável

| Item | Evidência atual |
|------|-----------------|
| Nome da obra | `obra-editar.tsx` |
| Status da obra | `obra-editar.tsx` (valores fixos) |
| `dataInicio`/`dataFim` | `obra-editar.tsx` |
| Localização | `obra-editar.tsx` |
| Responsável | `obra-editar.tsx` |
| Arquivar/restaurar | `obra-lista.tsx` |
| **Disciplinas** (criar/editar/arquivar/ordenar) | ❌ hoje derivado |
| **Frentes** (criar/editar/encerrar) | ❌ hoje derivado |
| **Serviços** (quantidade/unidade/produtividade/predecessora) | ❌ hoje derivado |
| **Produção real** (quantidade/data/equipe) | ❌ hoje derivado |
| **Planejamento** (overrides de duração, rede, marcos) | ❌ hoje derivado |
| **Caracterização** | ❌ hoje somente leitura |

---

## 31. O que deve ser configurável

| Item | Evidência atual |
|------|-----------------|
| Caracterização (campos por tipo de obra) | ❌ hoje shape fixo |
| Status (custom por obra) | ❌ hoje union fixa |
| Calendário (dias úteis/feriados) | ❌ hoje não existe |
| Tipo de atividade (marco/tarefa/duração) | ❌ hoje não existe |
| Produtividade (por serviço) | ❌ hoje `OBRA_SCOPE_REF` hardcoded |
| Unidades de medida | ❌ hoje hardcoded no escopo |

---

## 32. O que deve ser somente leitura

| Item | Evidência |
|------|-----------|
| `Obra.id` | `obra-types.ts`; `createObraId` |
| Resumo EAP | `obra-eap-repository.ts` → `deriveEapSummary` |
| LOB (grade) | `obra-lob-data.ts` → `derivarGradeLob` |
| Caminho crítico | `obra-planejamento-data.ts` → `marcarCriticoEPredecessora` |
| Datas derivadas do cronograma | `obra-planejamento-data.ts` → `derivarPlanejamento` |
| `ARQUIVADA` (derivado) | `obra-repository.ts` → `statusEfetivo` |

---

## 33. O que deve ser calculado

| Item | Calculado de | Evidência |
|------|--------------|-----------|
| Duração de serviço | qtd / produtividade | `obra-planejamento-data.ts` → `calcDuracao` |
| Datas de início/fim | Cronograma acumulado | `obra-planejamento-data.ts` → `derivarPlanejamento` |
| Caminho crítico | Durações (limiar 60%) | `obra-planejamento-data.ts` → `marcarCriticoEPredecessora` |
| Ritmo | qtd / duração | `obra-planejamento-data.ts` → `derivarPlanejamento` |
| Resumo EAP | Nós reais | `obra-eap-repository.ts` → `deriveEapSummary` |
| LOB | Planejamento | `obra-lob-data.ts` → `derivarGradeLob` |
| Avanço/desvio/projeção | Planejado × Realizado | (futuro) |

---

## 34. Proposta de cadeia de dependências futura (fontes de verdade explícitas)

```
┌─────────────────────────────────────────────────────────────────────┐
│                        FONTES DE VERDADE (dado por obra)            │
│                                                                     │
│  Obra (obra-repository.ts)                                          │
│   ├── id, nome, status, dataInicio, dataFim, localizacao,           │
│   │   responsavel, arquivada                                        │
│   ├── Caracterização (campos dinâmicos por tipo)                    │
│   ├── Disciplinas (entidade)                                        │
│   ├── EAP (obra-eap-repository.ts — nós por obraId)                 │
│   ├── Locais (entidade hierárquica)                                 │
│   ├── Frentes (entidade)                                            │
│   ├── Serviços (cadastro: eapWbs × frenteId × localId,              │
│   │   quantidade, unidade, produtividade, predecessora)             │
│   ├── Planejamento (atividades: serviçoId, duracao/override,        │
│   │   datas, rede, calendario, marcos)                              │
│   └── Produção (registro: serviçoId, data, quantidade, equipe)      │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        DERIVADOS (calculados, nunca fonte)          │
│                                                                     │
│  Duração        = qtd / produtividade                               │
│  Datas          = cronograma acumulado                              │
│  Caminho crítico= durações (limiar)                                 │
│  Resumo EAP     = deriveEapSummary(nós)                             │
│  LOB            = derivarGradeLob(planejamento)                     │
│  Avanço/desvio  = planejado × realizado                             │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        CAPACIDADES GENÉRICAS (neutras)              │
│                                                                     │
│  domains/planejamento  → PlanningDashboardData                      │
│  domains/servicos      → ServicosData                               │
│  domains/linha-de-balanco → LobGradeData                            │
│  (adapters traduzem o domínio para estes contratos)                 │
└─────────────────────────────────────────────────────────────────────┘
```

**Onde fica cada fonte de verdade (futuro):**

| Fonte de verdade | Onde | Evidência |
|------------------|------|-----------|
| Obra | `obra-repository.ts` | Já é fonte única ✅ |
| EAP | `obra-eap-repository.ts` (por obraId) | Já é fonte única ✅ |
| Caracterização | `Obra.caracterizacao` (dinâmico) | Hoje shape fixo |
| Disciplinas | Entidade por obra | Hoje derivado |
| Locais | Entidade por obra | Hoje não existe |
| Frentes | Entidade por obra | Hoje derivado |
| Serviços | Cadastro por obra | Hoje derivado |
| Planejamento | Baseline + overrides | Hoje derivado |
| Produção | Registro por obra | Hoje derivado |
| LOB | **NUNCA fonte** — derivada | ✅ correto |

---

## Conclusão

A arquitetura de **derivação** (EAP → planejamento → LOB/serviços/produção) e a **separação de capacidades genéricas** estão **corretas e bem feitas**. O problema está na **fonte de dados**: EAP, escopo, data de início e caracterização estão **fixos em código e específicos da obra-modelo**.

A infraestrutura **já suporta** múltiplas obras (repositórios por obraId), mas o **produto não expõe** a capacidade de configurar uma obra diferente. Para responder à pergunta central: **hoje NÃO é possível cadastrar uma obra completamente diferente sem alterar código.**

A correção prioritária (P0) é **desacoplar a fonte de dados da obra-modelo**: EAP por obra, escopo por obra, data por obra, e remover a dependência na validação. Isso destrava o restante (disciplinas, frentes, serviços, produção, planejamento) sem quebrar a arquitetura de derivação já existente.

---

## Verificação do documento

- [x] Arquivo existe: `docs/features/auditoria-editabilidade-modelo-obra.md`
- [x] Conteúdo completo (34 seções obrigatórias)
- [x] Nenhuma seção obrigatória ausente
- [x] Nenhuma alteração de código funcional (auditoria somente leitura)

---

*AUDITORIA DOCUMENTADA — AGUARDANDO APROVAÇÃO*
