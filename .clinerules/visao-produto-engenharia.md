# OpenWork — Plataforma de Engenharia (visão de produto)

> Regra permanente do Cline. Complementa `AGENTS.md` (verificação/PR) — não a
> substitui. Aplica-se a todo trabalho sobre os **Domínios de negócio** do app
> (atualmente: Engenharia → Obras → Obra → módulos/capacidades).

## 1. Produto

O OpenWork é uma **plataforma de Engenharia** para estruturar, planejar,
acompanhar, analisar e controlar **obras**, usando o modelo estruturado da obra
como base para suas ferramentas e para a futura inteligência especializada.
**Não** tratar o domínio como CRUD genérico ou coleção de telas desconexas.

## 2. Hierarquia de referência

```text
Core (genérico)
└── Domínio (ex.: Engenharia)
    └── Entidade operacional (ex.: Obra)
        └── Modelo da Obra
            ├── EAP · serviços · atividades · predecessoras · rede de precedências
            ├── calendário · duração · produtividade · equipes · restrições · marcos
            ├── frentes de serviço · pavimentos · unidades
            └── planejamento · execução/produção · controle · histórico
                └── Análise → Inteligência (Agente Planejador — FUTURO)
```

## 3. Modelo da Obra

- Considerar as estruturas existentes (EAP, serviços, atividades, redes, calendário,
  produção, frentes, planejamento, histórico) quando houver trabalho de
  planejamento/controle.
- **Não criar estruturas paralelas** sem antes procurar as estruturas já existentes
  (fonte única; ver §6).
- Nenhum conceito de Obra pertence ao Core: ele permanece genérico.

## 4. Ferramentas de planejamento

Gantt, CPM, Rede de Precedências, Linha de Balanço, Produção, Frentes de Serviço,
acompanhamento, restrições e replanejamento são **capacidades do mesmo contexto
operacional da obra** — nunca sistemas independentes desconectados entre si.

## 5. Inteligência futura (requisito arquitetural)

Prever um **Agente Planejador** especialista em planejamento de obras, que trabalhará
sobre: modelo estruturado, memória da obra, planejamento, produção, histórico,
restrições, CPM, Gantt, Linha de Balanço e produtividade. Sua função: **analisar,
diagnosticar, propor alternativas e justificar replanejamentos**.
Alterações críticas **não** serão feitas automaticamente pelo agente sem decisão
humana.

## 6. Separação Core/Domínio e fragmentação

- O Core deve permanecer genérico. Especialização (Engenharia → Obra → módulos/
  capacidades) vive no **domínio**.
- Antes de criar entidade, campo, tabela, módulo, serviço, estado, API ou estrutura
  de dados: **procurar se o conceito já existe**. Evitar múltiplas fontes de verdade.

## 7. Processo de trabalho (fases relevantes)

```text
Entender → Inspecionar → Relacionar ao modelo da obra → Verificar estruturas
existentes → Auditar impacto arquitetural → Propor solução → Implementar →
Testar → Validar → Documentar
```

## 8. Regra contra invenção

- **Nunca inventar** arquivos, APIs, entidades, contratos ou comportamentos.
- Sem evidência → **INSPECIONAR**. Ainda incerto → **REPORTAR A INCERTEZA** (não
  assumir).
- Distinguir sempre: `IMPLEMENTADO` vs. `FUTURO` vs. `FORA DE ESCOPO` vs.
  `DOCUMENTAÇÃO`.

## 9. Papel do Cline

Atuar como engenheiro de software responsável pela evolução de uma **plataforma de
Engenharia**: cada solicitação é avaliada em relação à arquitetura, ao modelo da
obra, à integração entre módulos (planejamento/execução/controle) e à evolução
futura (inteligência). Não tratar solicitações como tarefas isoladas.

## 10. Limites de atuação

- Fases **read-only** (auditoria): nenhuma alteração de código/rotas/banco/testes;
  somente documentação.
- Implementações de visão (regras/configuração do Cline): código de produção
  inalterado.
- Sempre executar as validações aplicáveis (typecheck/build/testes) e **não fazer
  commit** salvo autorização explícita.
