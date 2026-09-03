# FASE 06 — INTEGRAÇÃO DA EAP EXISTENTE AO MODELO OPERACIONAL (read-only — BLOQUEADA NA DESCOBERTA)

> **Data:** 2026-01-09 · **Tipo:** auditoria de descoberta — **nenhuma migração executada**.

## 1. Objetivo
Integrar a EAP já construída (fonte oficial) ao clone OpenWork, preservando nós,
hierarquia e IDs. **Bloqueada na etapa de descoberta**: a origem da EAP-modelo
(81 nós = 10/24/47) referenciada pelo clone **não foi localizada** em nenhuma fonte
acessível do ambiente.

## 2. Origem da EAP — candidatos examinados (evidências)
- `OPENWORK-LAB/modules/engenharia/data/storage/obras/OBRA-001.json` → EAP da obra
  "Torres do Vale" com **13 nós** (EAP-001..EAP-013; schema `obra-v1`, colunas
  eap_id/codigo_wbs/nome/tipo/pai/nivel/peso/descricao/observacao). Não é a alvo.
- `OPENWORK-LAB/modules/engenharia/data/{demonstracao.json, casos/CASO-001.json}` →
  sem nós EAP.
- `OPENWORK-LAB/modules/engenharia/tools/_eap_models.mjs` → catálogo de modelos de
  referência (residencial_vertical ~22 nós etc.) — propostas, não dados confirmados.
- Workbooks ARES (`obracopilot_excel/*.xlsx`, `_arquivado_2026-08-31/*.xlsx`,
  `modules/engenharia/reference/*.xlsx`): aba `EAP` com **85 linhas** de dados
  (20 DISCIPLINA / 62 PACOTE / 3 TRABALHO) — mesma estrutura em todos; não confere
  com 81 = 10/24/47.
- Busca por `OBRA-MODELO-EAP-001` fora do clone (modules/LAB): **0 ocorrências**.
- Relatório ARES `FASE_06_AUDITORIA_EAP.md`: a aba EAP do MVP era **placeholder**
  (vazia) em 19/08; preenchida posteriormente nos workbooks (estrutura acima).

## 3. Método utilizado para recuperação
- Leitura direta de JSON (LAB) e inspeção read-only de workbooks via openpyxl
  (somente leitura; nenhum xlsx foi aberto em modo escrita).
- Buscas textuais por IDs/termos de EAP e pelo literal da obra-modelo.

## 4. Uso do agente nativo
- **NÃO VERIFICADO/INDISPONÍVEL**: não há processo/ferramenta do "agente do OpenWork
  oficial" executando neste ambiente com acesso a uma origem da OBRA-MODELO-EAP-001;
  não há "exportação oficial" acessível para delegar a extração.

## 5. Fonte real dos dados
- **NÃO ENCONTRADA** (com o resumo esperado). A quantidade 81 nós = 10/24/47 existe
  apenas como **resumo** no clone (`obra-repository.ts` seed / `obra-eap.tsx`), sem
  dataset de nós rastreável no ambiente auditado.

## 6-7. Inventário e quantidade de nós
- Esperado (resumo do clone): 81 nós (10 raízes DISCIPLINA · 24 PACOTE · 47
  TRABALHO).
- Encontrado por candidato: Torres do Vale = 13 nós; workbooks ARES = 85 linhas
  (20/62/3); catálogo LAB = propostas de ~22 nós (referência).
- **Nenhum candidato equivale à estrutura do resumo.** `NÓS_ORIGINAIS == NÓS_MIGRADOS`
  não pode ser demonstrado.

## 8. Estrutura/campos dos candidatos
- Torres do Vale: `eap_id` (EAP-###), `codigo_wbs`, `nome`, `tipo`
  (DISCIPLINA/PACOTE/TRABALHO), `pai`, `nivel`, `peso/descricao/observacao`.
- Workbooks ARES (cabeçalho real): CÓDIGO WBS · EAP_ID · NOME · TIPO · PAI · NÍVEL ·
  SERVIÇO · DESCRIÇÃO (colunas 1-8; serviço como coluna de vínculo futuro).

## 9. Estratégia de IDs
- Não aplicada (sem origem). Princípio definido: preservar IDs originais; sem
  conversão silenciosa; mapeamento documentado se necessário.

## 10. Mapeamento para o clone
- Analisado conceitualmente (estruturas prontas: `Obra` por obraId, módulo EAP,
  navegação data-driven, repositório do domínio). Não executado.

## 11. Implementação
- **NENHUMA** (fase bloqueada antes de implementar; §4/§14).

## 12. Árvore clicável
- Não executada (depende dos nós integrados). A árvore data-driven existente está
  pronta para recebê-los quando a fonte for fornecida.

## 13. Validação estrutural
- Não aplicável (sem dados migrados).

## 14. Testes
- Nenhum teste novo; nenhum teste alterado; nenhum teste executado (sem mudança de
  código). Git status inalterado quanto a código.

## 15. Problemas encontrados
1. **BLOQUEIO — Origem da EAP-modelo (81 nós) não localizada** no ambiente
   (LAB/workbooks/docs).
2. Divergência estrutural entre candidatos e o resumo do clone (13, 85, ~22 vs 81).
3. Sem dataset oficial exportável acessível (agente nativo indisponível aqui).

## 16. Decisões arquiteturais
- Nenhuma implementação nesta fase.
- Quando a origem for fornecida, aplicar o plano já desenhado (FASES 04.x/05): modelo
  operacional único no domínio Engenharia; nós como dados (não hardcode); IDs
  preservados; capacidade de planejamento consumirá a mesma fonte.

## 17. Relação com planejamento futuro
- Mantida por decisão: EAP → serviço → atividade → rede/CPM/Gantt/LOB consumirão o
  modelo único da obra (princípio da FASE 05). Sem alteração neste ponto.

## 18. Pendências (ação necessária do usuário)
- Fornecer/indicar a **origem oficial** dos 81 nós da OBRA-MODELO-EAP-001 (arquivo,
  workbook com exportação, workspace ou dataset JSON) para viabilizar a integração
  com validação estrutural automática.

## 19. Veredito
**REPROVADO** — a FASE 06 não pode ser concluída: a fonte da EAP-modelo (81 nós)
não foi identificada no ambiente; sem ela, nenhuma integração com preservação de
nós/hierarquia/IDs pode ser executada com integridade verificável. (Conforme §4:
"Se alguma informação fundamental não puder ser determinada — PARAR E REPORTAR".)

## 20. Execução da fase
Nenhum código de produção alterado · nenhum xlsx alterado · nenhum commit ·
scripts temporários de inspeção removidos.
