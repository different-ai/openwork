# Auditoria e Proposta de Evolução do Workspace (FASE 22)

> **Status: PROPOSTA — aguardando aprovação. Nenhum código foi alterado.**
> Data: 2026-09-03 · Domínio: Engenharia · Obra: OBRA-MODELO-EAP-001
> Referência de produto/UX (padrões, NÃO cópia): Autodesk Construction Cloud / Autodesk Forma,
> Procore, Oracle Primavera Cloud, Buildertrend.

---

## 0. Resumo executivo

A FASE 21 entregou uma base sólida: domínio reutilizável (Planejamento, LOB, Serviços), shell da
obra com abas por fase, barra de KPIs derivada de dados reais, e a EAP real de 81 nós preservada.
Esta auditoria identifica **três lacunas de produto** que bloqueiam a evolução para um workspace
profissional de gestão de obras:

1. **Gestão de obras incompleta** — existe lista + criar, mas falta editar, arquivar, excluir com
   confirmação, busca, filtros, status real, datas, localização, responsável e a noção de "obra ativa".
2. **Extensibilidade de módulos frágil** — adicionar um módulo exige editar 3+ arquivos à mão
   (`obra-routes.ts`, `obra-shell-route.tsx`, `obra-navigation.ts`). Não há catálogo nem metadados.
3. **Dashboard sem experiência profissional** — a Visão Geral é uma grade estática de KPIs + cards,
   sem expandir/zoom, filtros, período, atualização, detalhes ou navegação do indicador ao módulo de origem.

A proposta abaixo define o **menor contrato arquitetural correto** para resolver as três, sem
implementar orçamento/medição/CPM/agentes/Skills/MCP agora, e sem refatoração ampla por estética.

---

## 1. Diagnóstico do Workspace atual

### 1.1 Hierarquia implementada hoje

```
/dominios/engenharia/obras            → ObraListaPage (lista de obras)
/dominios/engenharia/obras/nova       → ObraNovaPage (criar obra)
/dominios/engenharia/obras/:obraId    → ObraShellRoute (casca da obra)
/dominios/engenharia/obras/:obraId/:modulo → módulo da obra
```

A hierarquia conceitual `Central de Obras → Obra → Workspace → Fase → Módulo → Dados` **existe
parcialmente no código**, mas com lacunas:

| Nível | Estado atual | Observação |
|-------|-------------|------------|
| Central de Obras | ✅ `ObraListaPage` | Lista em cards; sem busca/filtros/status/edição/arquivo/exclusão |
| Obra | ⚠️ `Obra` (id, nome, status) | Modelo mínimo; status fixo `PROPOSTA`; sem datas/localização/responsável |
| Workspace | ✅ `ObraShellRoute` | Casca com abas por fase + subitens (FASE 21) |
| Fase | ✅ `OBRA_FASES` | Preparação/Execução/Suporte (hardcoded em `obra-routes.ts`) |
| Módulo | ⚠️ `OBRA_MODULES` + switch no shell | Catálogo hardcoded; adicionar módulo = editar 3+ arquivos |
| Dados | ✅ Adapters (Planejamento/LOB/Serviços) | Padrão de domínio reutilizável consolidado |

### 1.2 O que já está bem (a preservar)

- **Camada de domínio reutilizável** (`domains/planejamento`, `domains/linha-de-balanco`,
  `domains/servicos`) com contrato de tipos + lógica pura + componentes genéricos + adapter por
  domínio consumidor. **Este é o padrão-alvo.**
- **Fonte única**: `obra-repository.ts` (obras) e `obra-eap-repository.ts` (EAP por obraId) são as
  únicas fontes; a UI nunca toca em localStorage.
- **EAP real de 81 nós** (`obra-eap-data.ts`) preservada integralmente; resumo sempre derivado.
- **Separação de fontes**: ARES/Piemarta isolado em `obra-ares-referencia.ts`, nunca misturado.
- **Navegação data-driven**: `NavigationNode[]` + renderer genérico (`sidebar-navigation.tsx`).
- **Registro de domínios**: `registerDomain` permite adicionar um domínio inteiro sem tocar no Core.
- **Back button genérico** (`domain-back-button.tsx`) derivado da rota + árvore, sem estado duplicado.

### 1.3 Lacunas encontradas (detalhadas)

#### Lacuna A — Gestão de obras incompleta
- **Listar**: ✅ existe (cards). **Busca**: ❌ não existe. **Filtros**: ❌ não existe.
- **Criar**: ✅ existe (nome apenas). **Editar**: ❌ não existe (sem `updateObra`).
- **Abrir**: ✅ existe. **Voltar da obra para a central**: ⚠️ existe via `DomainBackButton`, mas o
  rótulo é genérico ("Voltar") e não há breadcrumb explícito de contexto.
- **Arquivar**: ❌ não existe. **Excluir com confirmação**: ❌ não existe (sem `deleteObra`).
- **Recuperação/segurança contra exclusão acidental**: ❌ não existe (sem soft-delete/arquivo).
- **Status**: ⚠️ apenas `"PROPOSTA"` (tipo `ObraStatus` com um único valor). Sem status real
  (planejamento/em execução/concluída/arquivada).
- **Datas início/fim, localização, responsável**: ❌ não existem no modelo `Obra`.
- **Informações resumidas da obra**: ⚠️ parcial (nome, status, id; caracterização/EAP quando existem).

#### Lacuna B — Extensibilidade de módulos frágil
- **Catálogo de domínios**: ✅ existe para domínios (Engenharia), mas **não para módulos** dentro de
  uma obra.
- **Módulos habilitados por obra**: ❌ não existe (todos os módulos sempre aparecem).
- **Módulos padrão/opcionais**: ❌ não existe.
- **Adicionar novo domínio sem editar a Sidebar**: ✅ para domínios (via `registerDomain`), mas
  **❌ para módulos** — adicionar um módulo exige editar `obra-routes.ts` (OBRA_FASES + label),
  `obra-shell-route.tsx` (switch de conteúdo), e `obra-navigation.ts` (via OBRA_FASES).
- **Metadados do módulo**: ❌ não existe (só `id` + `label`).
- **Ordem/grupo do módulo**: ⚠️ implícito na ordem do array `OBRA_FASES`; não é um dado declarativo
  por módulo.
- **Disponibilidade por fase**: ⚠️ implícito no agrupamento `OBRA_FASES`.
- **Configuração por obra**: ❌ não existe.

#### Lacuna C — Dashboard sem experiência profissional
- **Expandir KPI/card**: ❌ não existe (grade estática).
- **Zoom / visualização ampliada**: ❌ não existe.
- **Filtros**: ❌ não existe. **Período**: ❌ não existe. **Atualização**: ❌ não existe.
- **Detalhes**: ⚠️ parcial (EAP tem árvore + detalhe do nó selecionado; Visão Geral não).
- **Navegação do indicador ao módulo de origem**: ❌ não existe (KPI não é clicável).
- **Reorganização futura dos cards**: ❌ não existe (layout fixo).

---

## 2. Referências / padrões de produto identificados

> **Aviso**: estes são **padrões de produto/UX** observados nos sistemas citados, usados apenas como
> referência conceitual. **Nenhum código, arquitetura ou interface é copiado.**

### 2.1 Autodesk Construction Cloud / Autodesk Forma
- **Central de projetos**: uma tela de "todos os projetos" com busca, filtros por status e cards
  resumidos (nome, local, datas, progresso). Abrir um projeto leva a um **workspace dedicado**.
- **Contexto persistente**: o projeto ativo fica visível no header; a navegação lateral é específica
  do projeto (módulos do projeto), não global.
- **Dashboard por módulo**: cada módulo (Documentos, Modelos, Custos, Cronograma) tem sua própria
  visão com KPIs e drill-down para o detalhe.

### 2.2 Procore
- **Projeto como contêiner**: tudo vive dentro de um projeto; a lista de projetos é a porta de
  entrada. Cada projeto tem **módulos habilitados** (configuráveis por projeto).
- **Tool directory**: catálogo de ferramentas/módulos que podem ser ativados/desativados por projeto.
- **Status de projeto**: estados claros (em andamento, concluído, arquivado) com filtros na lista.
- **Ações contextuais**: editar, arquivar, excluir com confirmação e proteção contra exclusão
  acidental (soft-delete/arquivamento).

### 2.3 Oracle Primavera Cloud
- **Workspace por projeto**: navegação em abas por área (Cronograma, Recursos, Custos, Relatórios).
- **Dashboard com widgets**: painéis compostos por widgets (KPIs, gráficos, listas) que podem ser
  expandidos para tela cheia e configurados.
- **Drill-down**: clicar num indicador navega para o detalhe (ex.: clicar num KPI de atraso abre o
  cronograma filtrado).

### 2.4 Buildertrend
- **Projeto como unidade central**: lista de projetos com busca/filtros; cada projeto tem um
  dashboard com visão geral (progresso, próximos passos, finanças).
- **Fases do projeto**: navegação por estágios do ciclo de vida.
- **Ações primárias claras**: botões de ação principal por contexto (criar, editar, arquivar).

### 2.5 Padrões transversais úteis (síntese)
1. **Central de projetos como porta de entrada** — lista com busca/filtros/status + cards resumidos.
2. **Projeto ativo como contexto** — header mostra o projeto atual; navegação é por módulo do projeto.
3. **Catálogo de módulos configurável por projeto** — módulos padrão + opcionais, com metadados.
4. **Dashboard com widgets expansíveis** — KPIs clicáveis com drill-down ao módulo de origem.
5. **Ciclo de vida de projeto** — status real + arquivamento (soft-delete) + exclusão com confirmação.
6. **Breadcrumb de contexto** — hierarquia visível (Central → Obra → Fase → Módulo).

---

## 3. Proposta de arquitetura

### 3.1 Hierarquia-alvo

```
Central de Obras (lista + busca + filtros + criar)
   ↓
Obra (identidade + status + datas + localização + responsável)
   ↓
Workspace da Obra (shell: header de contexto + nav por fase + conteúdo)
   ↓
Fase (Preparação / Execução / Suporte)
   ↓
Módulo (catálogo declarativo com metadados)
   ↓
Dados (adapter → capacidade reutilizável)
```

**Princípio**: a `Central de Obras` é **independente do Workspace interno da obra**. A central é a
porta de entrada (lista/gestão); o workspace é o ambiente de trabalho de uma obra específica.

### 3.2 Camadas propostas

| Camada | Responsabilidade | Onde vive |
|--------|------------------|-----------|
| **Central de Obras** | Listar, buscar, filtrar, criar, editar, arquivar, excluir obras | `obra-lista.tsx` + `obra-central` (novo) |
| **Modelo Obra** | Identidade + status + datas + localização + responsável + ativa | `obra-types.ts` (evoluir) |
| **Repositório Obra** | CRUD completo + soft-delete/arquivo + persistência | `obra-repository.ts` (evoluir) |
| **Catálogo de Módulos** | Metadados declarativos de cada módulo (id, label, fase, ordem, opcional) | `obra-modules.ts` (novo) |
| **Shell da Obra** | Header de contexto + nav por fase + renderização por catálogo | `obra-shell-route.tsx` (evoluir) |
| **Dashboard** | Widgets expansíveis + drill-down | `obra-dashboard` (novo) + `obra-kpi-bar` (evoluir) |

---

## 4. Proposta mínima para gerenciamento de obras (Lacuna A)

### 4.1 Modelo `Obra` (evolução mínima, sem inventar campos)

```ts
type ObraStatus = "PROPOSTA" | "PLANEJAMENTO" | "EM_EXECUCAO" | "CONCLUIDA" | "ARQUIVADA";

type Obra = {
  id: string;
  nome: string;
  status: ObraStatus;
  /** Datas opcionais — só preenchidas quando houver dado real. */
  dataInicio?: string | null;   // ISO
  dataFim?: string | null;      // ISO
  localizacao?: string | null;
  responsavel?: string | null;
  /** Soft-delete: obra arquivada não aparece na lista ativa por padrão. */
  arquivada?: boolean;
  caracterizacao?: ObraCaracterizacao | null;
  eap?: ObraEapSummary | null;
};
```

**Justificativa arquitetural de cada campo** (nada é inventado):
- `status` — já existe; **expandir** de um único valor para o ciclo de vida real (necessário para
  filtros e identidade profissional). `ARQUIVADA` é derivado de `arquivada` para não duplicar.
- `dataInicio`/`dataFim` — já existem **derivados** no planejamento (`DATA_INICIO_OBRA`,
  `duracaoTotalDasLinhas`). Promover a data de início a campo da obra é a fonte única; o fim pode ser
  derivado do planejamento quando existir. **Não duplicar**: se a obra tem EAP, `dataFim` é derivado.
- `localizacao`/`responsavel` — campos de identificação comuns a qualquer projeto; opcionais.
- `arquivada` — soft-delete (padrão Procore/Buildertrend) para segurança contra exclusão acidental.

**Decisão a confirmar**: `dataInicio` deve ser **campo da obra** (fonte única) ou continuar derivado
do planejamento? Recomendo: campo opcional na obra; quando ausente, deriva de `DATA_INICIO_OBRA`.

### 4.2 Repositório (operações)

```ts
// Adições ao ObraRepositoryState
updateObra: (id: string, patch: Partial<Obra>) => void;
archiveObra: (id: string) => void;      // soft-delete (arquivada = true)
unarchiveObra: (id: string) => void;    // restaurar
deleteObra: (id: string) => void;       // exclusão definitiva (com confirmação na UI)
```

- `archiveObra`/`unarchiveObra` — **soft-delete** (segurança contra exclusão acidental).
- `deleteObra` — **exclusão definitiva**, sempre precedida de confirmação explícita na UI; também
  remove a EAP da obra (`obra-eap-repository`) para não deixar órfãos.
- `updateObra` — edição de identificação/status/datas/localização/responsável.

### 4.3 Central de Obras (UI)

- **Lista**: cards (atual) + **busca** por nome/id + **filtros** por status.
- **Card resumido**: nome, status (badge colorido), id, datas (quando houver), localização,
  responsável (quando houver), indicador de obra ativa.
- **Ações por card**: Abrir, Editar, Arquivar/Restaurar, Excluir (com diálogo de confirmação).
- **Obra ativa**: conceito de "obra atualmente aberta" (persistido em `obra-store`), destacada na
  lista e usada como contexto no header do workspace.
- **Voltar da obra para a central**: breadcrumb explícito `Central de Obras → <Obra>` + botão
  "Voltar" (já existe via `DomainBackButton`, melhorar rótulo).

### 4.4 Páginas novas/evoluídas

| Página | Ação |
|--------|------|
| `obra-lista.tsx` | Evoluir: busca + filtros + ações por card + obra ativa |
| `obra-nova.tsx` | Evoluir: campos opcionais (status, dataInicio, localização, responsável) |
| `obra-editar.tsx` | **Nova**: edição de identificação |
| `obra-central.tsx` | **Nova** (opcional): se quisermos separar a central do domínio — ver decisão |

---

## 5. Proposta mínima para extensibilidade de domínios (Lacuna B)

### 5.1 Catálogo de módulos declarativo

Criar `obra-modules.ts` com o **menor contrato** que permita evolução futura sem plugin complexo:

```ts
type ObraModuleId = "visao-geral" | "caracterizacao" | "eap" | ...;

type ObraModuleDef = {
  id: ObraModuleId;
  label: string;
  fase: ObraFase;            // grupo (Preparação/Execução/Suporte)
  ordem: number;             // ordem dentro da fase
  opcional?: boolean;        // módulo opcional (não padrão)
  descricao?: string;        // metadado para catálogo/help
  render: (obra: Obra) => ReactNode;  // renderização do módulo
};

const OBRA_MODULES: ObraModuleDef[] = [ ... ];
```

**Benefícios**:
- **Um único lugar** define id, label, fase, ordem, opcionalidade e renderização.
- `obra-shell-route.tsx` passa a **iterar o catálogo** em vez de um `switch` hardcoded.
- `obra-navigation.ts` deriva a sidebar do catálogo (fase + ordem).
- Adicionar um módulo = **adicionar uma entrada no catálogo** (e o adapter/capacidade), sem tocar no
  shell nem na navegação.

### 5.2 Módulos habilitados por obra (preparação, não implementação)

- Adicionar ao modelo `Obra` um campo opcional `modulosHabilitados?: ObraModuleId[]`.
- Quando ausente, usa o catálogo completo (padrão). Quando presente, filtra o catálogo.
- **Não implementar agora** a UI de configuração por obra; apenas deixar o contrato pronto.

### 5.3 O que NÃO fazer agora

- ❌ Sistema de plugins (registro dinâmico de módulos em runtime).
- ❌ Carregamento dinâmico/lazy de módulos.
- ❌ Configuração visual de módulos por obra (só o contrato de dados).

---

## 6. Proposta de dashboard profissional (Lacuna C)

### 6.1 Princípio

Não é "aumentar o tamanho da página". É uma **experiência de dashboard** com widgets que podem ser
**expandidos, filtrados e navegados** ao módulo de origem — comparável conceitualmente a
Primavera/Procore.

### 6.2 Componentes

#### `ObraKpiCard` (evoluir `KpiBar`)
- Cada KPI vira um **card clicável** com:
  - `onClick` → navega para o módulo de origem (ex.: KPI "Nós EAP" → `/obras/:id/eap`).
  - `data-kpi` + `data-kpi-target` (rota de origem) para testes.
- **Expandir**: botão de expandir (maximizar) que abre o card em **tela cheia / modal** com o
  detalhe do indicador.

#### `ObraDashboard` (novo)
- Grade de **widgets** (KPI cards + cards de contexto: caracterização, status, datas).
- Cada widget tem: **expandir** (tela cheia), **filtro** (quando aplicável), **período** (quando
  aplicável), **atualizar** (recalcular), **detalhes** (drill-down).
- **Navegação do indicador**: cada KPI aponta para o módulo de origem (rota).
- **Reorganização futura**: layout em grade com `data-widget` + ordem (preparação; não implementar
  drag-and-drop agora).

### 6.3 O que implementar agora vs. depois

| Recurso | Agora | Depois |
|---------|-------|--------|
| KPI clicável → módulo de origem | ✅ | |
| Expandir KPI/card (tela cheia/modal) | ✅ | |
| Filtros por widget | ⚠️ só onde houver dado real | |
| Período | ⚠️ derivado do planejamento | |
| Atualizar (recalcular) | ✅ (re-deriva dos dados) | |
| Detalhes (drill-down) | ✅ (navega ao módulo) | |
| Reorganização (drag-and-drop) | | ✅ fase posterior |
| Gráficos (barras/linhas) | | ✅ fase posterior (com dados de medição) |

---

## 7. O que deve ser implementado agora

Escopo mínimo da FASE 22 (após aprovação):

1. **Modelo `Obra` evoluído** — status expandido, datas opcionais, localização, responsável,
   `arquivada` (soft-delete).
2. **Repositório** — `updateObra`, `archiveObra`, `unarchiveObra`, `deleteObra` (com limpeza da EAP).
3. **Central de Obras** — busca, filtros por status, ações por card (editar/arquivar/excluir com
   confirmação), obra ativa, breadcrumb de contexto.
4. **Páginas** — `obra-editar.tsx` (nova), evoluir `obra-lista.tsx` e `obra-nova.tsx`.
5. **Catálogo de módulos** — `obra-modules.ts` declarativo; refatorar `obra-shell-route.tsx` e
   `obra-navigation.ts` para iterar o catálogo (sem mudar comportamento).
6. **Dashboard** — `ObraKpiCard` clicável com drill-down ao módulo de origem + expandir; `ObraDashboard`.
7. **Testes** — CRUD, soft-delete, catálogo, dashboard, shell por catálogo.

---

## 8. O que deve ficar para fases posteriores

- ❌ Orçamento, Medição, Indicadores completos.
- ❌ CPM/Rede de precedências.
- ❌ Novos agentes, Skills/MCP reais.
- ❌ Sistema de plugins de módulos (registro dinâmico).
- ❌ Configuração visual de módulos por obra (só contrato de dados).
- ❌ Drag-and-drop de widgets / gráficos avançados.
- ❌ Multiobra com dados distintos por obra (a arquitetura prepara, mas não implementa).

---

## 9. Riscos de arquitetura

| Risco | Mitigação |
|-------|-----------|
| Quebrar a EAP real de 81 nós | Nenhuma alteração em `obra-eap-data.ts`; testes de regressão (81 nós) |
| Perder a separação ARES/Piemarta | Dataset isolado e rotulado; testes de separação mantidos |
| `deleteObra` deixar EAP órfã | `deleteObra` remove a EAP da obra no mesmo repositório |
| Refatorar o shell para catálogo introduzir bug | Testes SSR do shell (fases/módulos) mantidos; catálogo testado |
| `dataFim` duplicado (obra vs. planejamento) | `dataFim` derivado do planejamento quando EAP existe; campo só quando não há EAP |
| Escopo crescer demais | FASE 22 limitada a gestão + catálogo + dashboard; orçamento/medição/CPM fora |
| `ObraStatus` expandido quebrar consumidores | `PROPOSTA` mantido como valor válido; testes de compatibilidade |

---

## 10. Impacto sobre o que já foi implementado na FASE 21

| FASE 21 item | Impacto da FASE 22 |
|--------------|--------------------|
| `obra-shell-route.tsx` (abas por fase) | **Refatorado** para iterar o catálogo de módulos; comportamento visual preservado |
| `obra-navigation.ts` (sidebar por fase) | **Refatorado** para derivar do catálogo; mesma árvore resultante |
| `obra-kpi-bar.tsx` | **Evoluído** para `ObraKpiCard` clicável + expandir; API compatível |
| `obra-visao-geral.tsx` | **Evoluído** para `ObraDashboard` (widgets + drill-down) |
| `obra-lista.tsx` / `obra-nova.tsx` | **Evoluídos** (busca/filtros/ações; campos opcionais) |
| `obra-repository.ts` / `obra-storage.ts` | **Evoluídos** (CRUD completo + soft-delete) |
| `obra-types.ts` | **Evoluído** (status, datas, localização, responsável, arquivada) |
| `obra-eap-data.ts` (81 nós) | **Intacto** |
| `obra-ares-referencia.ts` | **Intacto** |
| `domains/planejamento`, `linha-de-balanco`, `servicos` | **Intactos** (capacidades reutilizáveis) |
| Adapters (Planejamento/LOB/Serviços) | **Intactos** |

**Nenhuma capacidade reutilizável (Planejamento/LOB/Serviços) é alterada.** A FASE 22 toca apenas a
camada de gestão de obras + shell + dashboard do domínio Engenharia.

---

## 11. Ordem recomendada de implementação

1. **Modelo `Obra` + repositório** (tipos, CRUD, soft-delete, storage) + testes.
2. **Catálogo de módulos** (`obra-modules.ts`) + refatorar shell e navegação para iterar o catálogo
   (sem mudar comportamento) + testes de regressão.
3. **Central de Obras** (busca, filtros, ações por card, obra ativa, breadcrumb) + páginas
   `obra-editar.tsx` + evoluir `obra-lista.tsx`/`obra-nova.tsx` + testes.
4. **Dashboard** (`ObraKpiCard` clicável + expandir; `ObraDashboard`) + testes.
5. **Verificação final**: testes específicos + `pnpm typecheck` + build.

---

## 12. Decisões que preciso de você

1. **Escopo da FASE 22** — concorda com o corte (gestão de obras + catálogo de módulos + dashboard,
   sem orçamento/medição/CPM/agentes/Skills/MCP)?
2. **`dataInicio`** — campo opcional na obra (fonte única) ou continuar derivado do planejamento?
   Recomendo: campo opcional; deriva quando ausente.
3. **Central de Obras** — manter dentro do domínio Engenharia (`/dominios/engenharia/obras`) ou criar
   uma camada separada de "Central de Obras" independente do domínio? Recomendo: manter no domínio
   (menor diff; a central já é a home do domínio).
4. **Exclusão** — soft-delete (arquivar) como padrão + exclusão definitiva com confirmação em duas
   etapas? Recomendo: sim.
5. **Dashboard** — KPIs clicáveis com drill-down + expandir em tela cheia; reorganização
   (drag-and-drop) fica para depois? Recomendo: sim.

**Aguardando sua aprovação e respostas às decisões acima. Nenhum código foi alterado.**
