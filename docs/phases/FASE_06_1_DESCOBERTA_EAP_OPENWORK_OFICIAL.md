# FASE 06.1 — DESCOBERTA DA EAP NA INSTALAÇÃO OFICIAL DO OPENWORK (read-only)

> **Data:** 2026-01-09 · **Tipo:** descoberta — nenhuma migração; nenhum arquivo alterado.

## 1. Objetivo
Localizar a origem oficial da EAP-modelo (81 nós) na instalação local do OpenWork.

## 2. Contexto
FASE 06 bloqueada: a origem não estava no clone/LAB. Informado que a EAP foi
construída no OpenWork oficial instalado na máquina.

## 3. Localização do OpenWork oficial [ENCONTRADO]
- Instalação: `C:\Users\Correta Engenharia\AppData\Local\Programs\@openworkdesktop`.
- Dados do app (Electron): `%APPDATA%\com.differentai.openwork`.
- **Workspace da obra-modelo (origem da EAP):**
  `C:\Users\Correta Engenharia\OBRAS-MODELO\OBRA-MODELO-EAP-001`
  (workspace com `opencode.jsonc`, `data/`, `knowledge/`, `registro/`,
  `validacao/`, `interface/`).

## 4. Diretórios investigados (controlados)
`%LOCALAPPDATA%\Programs` · `%APPDATA%\@openwork|openwork|com.differentai.openwork` ·
`%USERPROFILE%\{OBRAS-MODELO, OpenWork Chat, .openwork, .ares}`. Nenhuma varredura
indiscriminada.

## 5. Mecanismo de persistência identificado
A EAP **não** fica em banco da obra: fica em **arquivos JSON/MD dentro do workspace**
aberto no OpenWork oficial. O app mantém metadados de workspaces em
`com.differentai.openwork` (não inspecionado em profundidade — desnecessário).

## 6. Estratégia de busca
Busca por literal `OBRA-MODELO-EAP-001` e por estrutura nos diretórios oficiais;
leituras de JSON/verificador; inspeção do workspace nomeado.

## 7. Candidatos encontrados
1. **`OBRAS-MODELO\OBRA-MODELO-EAP-001\data\eap\OBRA-MODELO-EAP-001-eap.json`**
   → **ORIGEM OFICIAL** (workspace do OpenWork oficial).
2. `...\data\eap\OBRA-MODELO-EAP-001-eap-FASE-19.2.json` → versão anterior.
3. `...\data\OBRA-MODELO-EAP-001.json` → caracterização (resumo).
4. `...\registro\EAP-ARVORE.md` → árvore textual; declara "Total de nós: 81".
5. `...\validacao\verifica-eap.mjs` → verificador estrutural oficial (ok:true).

## 8. Candidatos descartados
LAB `modules/engenharia` (Torres do Vale — 13 nós), workbooks ARES (85 linhas,
estrutura distinta), catálogos `_eap_models` (propostas), fixtures/mocks — não
pertencem à obra-modelo do OpenWork oficial.

## 9. EAP oficial localizada
**SIM** — `...\data\eap\OBRA-MODELO-EAP-001-eap.json`.

## 10. Inventário (resumo)
obra_id `OBRA-MODELO-EAP-001` · nome "Edifício Residencial Modelo EAP" · status
**PROPOSTA** · versão **FASE-19.5** · caracterização (resumo): torres 1, lajes 14,
pilotis, sobresolo, unidades 1, subsolos 0, concreto armado, cobertura prevista.
## 11. Quantidade de nós
**81** (confere com a referência).

## 12. Distribuição por tipo
DISCIPLINA **10** (nível 1) · PACOTE **24** (nível 2) · TRABALHO **47** (nível 3).
Folhas: 47 · Raízes: 10.

## 13. Estrutura
`wbs` como identificador hierárquico (`1`, `1.1`, `1.1.1`), `nome`, `nivel`, `tipo`,
`pai` (referência ao `wbs` pai; null na raiz), `fundamentacao`, `condicao`. Ordem dos
irmãos = ordem de ocorrência no array (pré-order). Sem campo `ordem` explícito.

## 14. IDs
Identificador = `wbs` + `obra_id` (sem `eap_id` sequencial). Estratégia de
preservação na migração: manter `wbs`; mapear explicitamente se o clone exigir id
adicional — decidir na fase de migração.

## 15. Integridade (verificador oficial executado — somente leitura)
`node validacao\verifica-eap.mjs` → **ok: true** · 81 WBS únicos/81 nós ·
nível/tipo consistentes (0 erros) · pais existentes/níveis corretos · sem ciclo ·
campos obrigatórios presentes. Inventário independente: 0 WBS duplicados, 0 pais
inexistentes, 0 nós sem pai acima do nível 1.

## 16. Comparação com o clone
Clone: resumo em seed (`obra-repository.ts`: eap.total 81, raizes 10, pacotes 24,
trabalhos 47, PROPOSTA) — **coincide exatamente** com a origem. O clone **não
possui os nós** (apenas o resumo). Sem duplicidade; diferença = destino precisa
receber os nós na migração.

## 17. Acesso ao agente nativo
Instalação oficial presente (`Programs\@openworkdesktop`). Para esta descoberta os
dados foram lidos **diretamente dos arquivos do workspace** (fonte canônica); o
agente nativo não foi usado (nada alterado). Instalação acessível; agente não
executado nesta fase.

## 18. Evidências
- `registro\EAP-ARVORE.md` (Total: 81; árvore completa).
- `validacao\verifica-eap.mjs` (regras + saída ok:true; 81 únicos).
- `data\eap\OBRA-MODELO-EAP-001-eap.json` (nós/campos; versão FASE-19.5).
- Inventário executado: 81 = 10/24/47; 0 duplicados/órfãos/pais inexistentes.

## 19. Limitações
- `com.differentai.openwork\openwork-workspaces.json` não foi aberto (desnecessário).
- Arquivo antigo/parcial da EAP no mesmo diretório (FASE-19.2) — fonte canônica =
  arquivo FASE-19.5 atual (identificar claramente na migração).

## 20. Próximo passo recomendado (NÃO executar nesta fase)
Fase de migração autorizada: ler `OBRA-MODELO-EAP-001-eap.json` (81 nós) e integrar
no clone (domínio Engenharia) preservando `wbs`/hierarquia/ordem/campos, com
validação estrutural automática (81 = 10/24/47; sem órfãos/ciclos).

## Resultado da fase
- OpenWork oficial encontrado: **SIM** · EAP oficial encontrada: **SIM**
- Quantidade: **81 nós** · Estrutura: **10 DISCIPLINA / 24 PACOTE / 47 TRABALHO**
- Localização: `C:\Users\Correta Engenharia\OBRAS-MODELO\OBRA-MODELO-EAP-001\data\eap\OBRA-MODELO-EAP-001-eap.json`
- Confiança: **CONFIRMADO** · Agente nativo: instalação presente (agente não executado)
- Código alterado: NÃO · Dados alterados: NÃO
- Testes: NÃO executados (sem alteração; apenas comandos de leitura/diagnóstico)
- Git status: sem alterações de código nesta fase

## Veredito
**LOCALIZADA — AGUARDANDO FASE DE MIGRAÇÃO**

