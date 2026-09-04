# Mapeamento ARES (19 abas) → App OBRA-MODELO-EAP

> Documento de decisão — comparação entre a planilha **ARES_MODELO_EXCEL_NATIVO_MVP_LOB_PROFISSIONAL_FINAL_WORK.xlsx** (19 abas) e o que está implementado no app hoje.
> Objetivo: dar visibilidade completa antes de decidir o escopo de expansão.

## Resumo executivo

A planilha ARES é um **modelo de engenharia completo e multi-dimensional**. O app hoje implementa uma **versão reduzida** (7 abas equivalentes), focada na EAP + Planejamento + Linha de Balanço. Há **10 abas da ARES que ainda não existem no app** (Orçamento, Rede, Caminho Crítico, Recursos, Medição, Controle, Indicadores, Gráficos, Fórmulas, Configurações) e **2 que existem só como placeholder** (Frentes, Produção).

A diferença conceitual mais importante: a ARES define **SERVIÇO = EAP × FRENTE × LOCALIZAÇÃO** (unidade operacional de cruzamento), e o **PLANEJAMENTO** é um cronograma real com datas/predecessoras/%plan/%real/status. O app hoje deriva o cronograma dos nós da EAP, sem essa dimensão de cruzamento.

---

## Mapeamento aba a aba

Legenda de estado no app:
- ✅ **Implementado** — módulo real com dados derivados
- 🟡 **Parcial** — existe, mas simplificado ou com placeholder
- ⬜ **Não existe** — falta criar

| # | Aba ARES | O que é (ARES) | Estado no app | O que falta / observação |
|---|----------|----------------|---------------|--------------------------|
| 1 | **DASHBOARD** | Painel executivo: progresso físico, status da obra, prazo, equipes, resumo de serviços, evolução mensal planejado×realizado | 🟡 Visão Geral | Visão Geral existe mas não tem os indicadores financeiros/equipes/evolução mensal da ARES |
| 2 | **CADASTRO** | Dados da obra + hierarquia de locais (empreendimento→torres→pavimentos→apartamentos) + tipologias | 🟡 Caracterização | Caracterização existe (dados básicos), mas **não tem a hierarquia de locais** (LOCAL-E01, LOCAL-T1-P01-AP01...) nem tipologias |
| 3 | **FRENTES** | Natureza/especialidade do trabalho (16 frentes) + equipes | ✅ Frentes | Frentes derivadas das 10 disciplinas raiz da EAP real (com contagem de pacotes/trabalhos). **Não usa** as 16 frentes da ARES (separação de fontes) |
| 4 | **EAP** | 20 disciplinas, 85 nós (DISCIPLINA/PACOTE/TRABALHO) | ✅ EAP | App tem **10 disciplinas / 81 nós**. A ARES tem **20 disciplinas / 85 nós** (mais granular: Pisos, Gesso/drywall, Fachada, Apartamentos, Áreas comuns, Áreas externas, Equipamentos, Comissionamento) |
| 5 | **SERVIÇOS** | Unidade operacional = EAP × FRENTE × LOCAL (12 serviços exemplo) | 🟡 Serviços | App mostra os 47 TRABALHO da EAP com duração/datas/crítico. **Não tem a dimensão de cruzamento** EAP×FRENTE×LOCAL nem quantidade/preço/status |
| 6 | **ORÇAMENTO** | Formação de custos: EAP→SERVIÇO→ITEM→COMPOSIÇÃO→RECURSOS→CUSTO→BDI→PREÇO | ⬜ Não existe | Falta módulo completo de orçamento (itens, composições, BDI) |
| 7 | **PLANEJAMENTO** | Cronograma real: 15 atividades legadas + modelo A2 (PLAN-xxx com TIPO_ATIVIDADE SERVIÇO/ESPECIAL/MARCO), datas, predecessoras, %plan/%real, status | 🟡 Planejamento | App deriva datas dos nós EAP. **Não tem** o cronograma real da ARES (datas explícitas, %plan/%real, status, TIPO_ATIVIDADE) |
| 8 | **REDE** | Rede de precedências (18 elos FS com defasagem) | ⬜ Não existe | Falta visualização da rede de precedências |
| 9 | **LINHA DE BALANÇO** | Grade tempo×serviço (11 serviços, semanas, células ativas) | ✅ Linha de Balanço | App tem a grade LOB em React. **Diferença de fonte**: ARES deriva das 15 atividades do PLANEJAMENTO; app deriva dos 81 nós EAP |
| 10 | **CAMINHO CRÍTICO** | Cálculo de folgas (início/término cedo/tarde, folga total/livre, crítica) | ⬜ Não existe | Falta módulo de caminho crítico/folgas |
| 11 | **GANTT** | Cronograma de barras (15 atividades, %real) | 🟡 Planejamento (timeline) | O PlanningDashboard tem Gantt, mas alimentado pelos nós EAP, não pelo cronograma real |
| 12 | **RECURSOS** | Mão de obra/equipamento/material (custo unitário, capacidade/dia) | ⬜ Não existe | Falta módulo de recursos |
| 13 | **PRODUÇÃO** | Acompanhamento diário planejado×realizado×acumulado | 🟡 Produção | Produção derivada do cronograma da EAP real (qtd. planejada + ritmo). Produção real (executada) ainda pendente de registro |
| 14 | **MEDIÇÃO** | Processo financeiro/contratual (valor contrato, medido, saldo, %medido) | ⬜ Não existe | Falta módulo de medição |
| 15 | **CONTROLE** | Planejado×realizado (estrutura vazia na ARES) | ⬜ Não existe | Falta módulo de controle |
| 16 | **INDICADORES** | 7 indicadores com valor/referência/status/leitura | ⬜ Não existe | Falta módulo de indicadores |
| 17 | **GRÁFICOS** | 5 gráficos ligados aos dados (evolução mensal, produção acumulada, medição, serviços por status, produtividade) | ⬜ Não existe | Falta módulo de gráficos |
| 18 | **FÓRMULAS** | Documentação das fórmulas do modelo | ⬜ Não existe | Falta documentação das fórmulas |
| 19 | **CONFIGURAÇÕES** | Parâmetros globais, listas de validação, BDI composto | ⬜ Não existe | Falta módulo de configurações |

---

## O que o app já tem (implementado)

| Módulo app | Fase | Fonte de dados | Status |
|------------|------|----------------|--------|
| Visão Geral | Preparação | Derivado | 🟡 parcial |
| Caracterização | Preparação | Dados da obra | 🟡 parcial |
| EAP | Preparação | 81 nós reais | ✅ |
| Disciplinas | Preparação | Derivado da EAP | ✅ |
| Serviços | Preparação | Derivado da EAP + planejamento | 🟡 parcial |
| Planejamento | Preparação | Derivado da EAP | 🟡 parcial |
| Linha de Balanço | Preparação | Derivado da EAP | ✅ |
| Frentes | Execução | Derivado da EAP real | ✅ |
| Produção | Execução | Derivado da EAP real | 🟡 parcial |
| RDO | Execução | — | 🟡 placeholder |
| IA | Suporte | — | 🟡 placeholder |

---

## Diferenças conceituais-chave

1. **SERVIÇO = EAP × FRENTE × LOCALIZAÇÃO** — a ARES cruza três dimensões para formar a unidade operacional. O app hoje trata "Serviços" como os TRABALHO da EAP, sem essa dimensão de cruzamento.

2. **PLANEJAMENTO é um cronograma real** — com datas explícitas, predecessoras, %plan/%real, status e TIPO_ATIVIDADE (SERVIÇO/ESPECIAL/MARCO/MOBILIZAÇÃO/ADMINISTRAÇÃO). O app deriva as datas dos nós EAP.

3. **EAP mais granular** — a ARES tem 20 disciplinas / 85 nós; o app tem 10 disciplinas / 81 nós.

4. **Cadeia completa de engenharia** — a ARES documenta a cadeia EAP → SERVIÇO → PLANEJAMENTO → PRODUÇÃO → MEDIÇÃO → INDICADORES → GRÁFICOS, com ORÇAMENTO e RECURSOS no meio. O app só cobre a parte de EAP/Planejamento/LOB.

---

## Opções de escopo

### Opção A — Expandir para as 19 abas (fiel à ARES)
Criar os módulos que faltam: Orçamento, Rede, Caminho Crítico, Recursos, Medição, Controle, Indicadores, Gráficos, Fórmulas, Configurações + completar Frentes/Produção + expandir EAP para 20 disciplinas + usar o cronograma real da ARES.
- **Esforço**: alto (várias fases)
- **Fidelidade**: máxima

### Opção B — Ajustar o atual com dados reais da ARES
Manter a estrutura atual (7 abas), mas:
- Usar o **cronograma real da ARES** (15 atividades com datas/predecessoras/%real) no Planejamento/Gantt/LOB
- Expandir a EAP para as 20 disciplinas da ARES
- Completar Frentes (lista real) e Produção (registro real)
- **Esforço**: médio
- **Fidelidade**: alta no que existe, sem as abas financeiras

### Opção C — Manter o atual
Não expandir. Manter a versão reduzida atual.
- **Esforço**: zero
- **Fidelidade**: baixa (só EAP/Planejamento/LOB)

---

## Recomendação

A **Opção B** é o melhor equilíbrio: corrige a maior divergência (usar o cronograma real da ARES em vez de datas derivadas) e expande a EAP para a granularidade correta, sem o esforço de construir todo o módulo financeiro (Orçamento/Medição/Indicadores) de uma vez. A Opção A pode ser feita depois, em fases, sobre a base da Opção B.

---

## Decisão do usuário (2026-09-03) — separação de fontes

O usuário definiu uma **regra de separação explícita** entre as duas obras, que **não podem ser misturadas**:

> **Obra real → EAP real de 81 nós**
> **ARES/Piemarta → dataset de referência para cronograma e validação**

Consequências práticas:

1. **A EAP real de 81 nós é preservada integralmente.** Ela representa os dados reais da obra e **não pode ser substituída** pela EAP pedagógica da Piemarta (20 disciplinas/85 nós).

2. **O cronograma da ARES/Piemarta (15 atividades) é um dataset de referência/demonstração**, usado para **validar a estrutura** de Planejamento, Gantt e LOB. **Não deve ser apresentado como cronograma da obra real.**

3. **Não misturar os dados das duas obras.** A separação deve ficar explícita no modelo e na documentação.

### Escopo da Opção B (revisado)

- ✅ Manter a EAP real de 81 nós e seu cronograma derivado (sem alteração).
- ✅ Criar um **dataset de referência ARES/Piemarta** (15 atividades com datas/predecessoras/%plan/%real/status) claramente separado, para validar a estrutura de Planejamento/Gantt/LOB.
- ✅ Completar Frentes (16 frentes + equipes) e Produção (registro real).
- ❌ **Não** substituir a EAP real pela da ARES.
- ❌ **Não** apresentar o cronograma da ARES como cronograma da obra real.
