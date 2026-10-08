# Revisão por subagentes: navegação e unidades

Atualização posterior: os sete problemas abaixo foram corrigidos. Veja o [relatório dos consertos e da validação](2026-10-07-workers-fixes.md). O texto abaixo preserva os achados e reproduções da revisão anterior às correções.

Data: 2026-10-07. Revisão do estado atual do workspace, com três subagentes: navegação/engenharia, simulação/recursos e integração visual/testes. A raiz consolidou duplicatas e reproduziu os dois problemas de atribuição. Os agentes usaram reproduções pequenas em Node e, para a interação, a prévia de produção no Edge. Nenhuma correção no código de produção foi aplicada nesta rodada.

Foram confirmados sete problemas P2. Os testes que passaram na implementação continuam sendo evidência dos cenários cobertos; estes achados expõem cenários adicionais que ainda não tinham regressões.

## Problemas confirmados

### 1. Girar a câmera impede cliques esquerdos posteriores

**Local:** [workersView.ts:122](../../../apps/sandbox/src/workersView.ts#L122), com [orbitCamera.ts:83](../../../packages/engine/src/interact/orbitCamera.ts#L83).

O `pointerup` da view recusa toda interação quando `lastDragDistance >= 6`. A câmera só zera essa distância no início de um gesto direito/do meio. Assim, o arrasto anterior continua invalidando cliques esquerdos independentes.

**Reprodução no Edge:** arrastar com botão direito por 50 px; selecionar Escavar e clicar no terreno. Nenhuma ordem é criada. Após um clique direito sem arrasto, o mesmo clique esquerdo cria a ordem. Seleção e construção também passam pelo mesmo guard.

**Correção:** medir a distância do próprio gesto da view ou zerar a medição em todo `pointerdown`, mantendo o bloqueio do gesto que realmente foi um arrasto. Testar rotação seguida de seleção e designação manual.

### 2. Proxies de unidades podem ficar impossíveis de selecionar

**Local:** [workersView.ts:93](../../../apps/sandbox/src/workersView.ts#L93) e [workersView.ts:110](../../../apps/sandbox/src/workersView.ts#L110).

As matrizes do `InstancedMesh` mudam a cada frame, mas a esfera usada pelo raycast permanece antiga. `frustumCulled = false` evita o descarte visual; não remove esse teste do raycast.

**Reprodução no Edge:** com oito unidades, fazer uma seleção calcula a esfera dos proxies ainda vazios, com raio -1. Adicionar 17 unidades, totalizando 25, e clicar no centro projetado da nº 25: ela não é selecionada. Chamar `proxies.computeBoundingSphere()` permite selecionar com o mesmo clique. Mover uma instância para fora de uma esfera anterior também reproduz a falha.

**Correção:** excluir proxies vazios do picking e atualizar a esfera antes do raycast, ou invalidá-la quando matrizes/count mudarem. Testar mais de 24 unidades e movimento dos proxies.

### 3. Oito tarefas inviáveis escondem tarefas executáveis

**Local:** [workers.ts:362](../../../packages/engine/src/sim/workers/workers.ts#L362) e [workers.ts:364](../../../packages/engine/src/sim/workers/workers.ts#L364).

O corte `slice(0, 8)` ocorre antes de verificar ferramenta/estoque. Tarefas com falta desses recursos permanecem elegíveis a cada tick e ocupam sempre a mesma shortlist. Uma tarefa executável mais distante nunca é considerada, mesmo estando na fronteira ativa.

**Reprodução em `Simulation`, confirmada pela raiz:** piso sólido até Y=3; unidade `[5,4,5]` com uma plank; oito ordens de construção de stone em X=6..13, Y=4, Z=5, sem stone no estoque; nona ordem de planks em `[20,4,5]`. Após 500 ticks: unidade ociosa, estoque de plank intacto e alvo vazio. Cancelar as oito primeiras permite concluir a nona e consumir a plank. Ferramentas heterogêneas sofrem do mesmo filtro.

**Correção:** filtrar elegibilidade por unidade antes do corte, ou avançar um cursor persistente entre candidatos. Preservar um orçamento de atribuição sem permitir que candidatos inviáveis monopolizem todas as tentativas.

### 4. Uma unidade sem acesso bloqueia a tarefa para outra com acesso

**Local:** [workers.ts:362](../../../packages/engine/src/sim/workers/workers.ts#L362), [workers.ts:177](../../../packages/engine/src/sim/workers/workers.ts#L177) e [workers.ts:266](../../../packages/engine/src/sim/workers/workers.ts#L266).

O resultado `no-access` de uma busca que depende da origem da unidade fica armazenado na tarefa global. Spawn e mudanças de disponibilidade não avançam a revisão usada para reavaliar a atribuição.

**Reprodução pela raiz:** mundo 32³, piso até Y=3, parede X=10, Y=4..15 em todo Z. Unidade nº 1 em `[5,4,5]` recebe escavação de stone em `[20,4,5]`; após 300 ticks a ordem registra `no-access`. Criar unidade nº 2 em `[19,4,5]` e parar a nº 1. Após mais 100 ticks, a nº 2 continua ociosa, apesar de adjacente ao alvo. Enviar `unitStock` com zero itens para a nº 2 acorda a revisão; a obra conclui e produz exatamente um drop.

**Correção:** registrar falha de acesso por unidade/origem ou componente navegável, e invalidar elegibilidade quando executores/ocupação mudarem. Apenas aumentar a revisão no spawn não resolve o problema geral de uma unidade inalcançável reapegar a tarefa primeiro.

### 5. Perder apoio antes da subida permite subir no ar

**Local:** [workers.ts:465](../../../packages/engine/src/sim/workers/workers.ts#L465).

A verificação de perda de apoio durante movimento só cobre `m.flat`. Uma subida iniciada ainda na origem ignora a remoção de seu piso.

**Reprodução independente em dois subagentes:** unidade `[5,4,5]`, degrau sólido `[6,4,5]`, destino `[6,5,5]`. Assim que entra em `walking`, remover `[5,3,5]`. A unidade sobe de Y256=1024 para 1108, 1194 e 1280 e conclui o movimento sem cair.

**Correção:** revalidar o apoio da origem antes da fase de subida/saída e definir o apoio necessário para cada fase da transição. Verificar `hasSupport` em todos os instantes indiscriminadamente também seria incorreto: a interpolação vertical planejada passa acima do piso. Acrescentar regressões de subida e descida após edições de apoio.

### 6. Busca limitada é apresentada como ausência de caminho

**Local:** [engineering.ts:90](../../../packages/engine/src/sim/navigation/engineering.ts#L90), [engineering.ts:75](../../../packages/engine/src/sim/navigation/engineering.ts#L75) e [workers.ts:512](../../../packages/engine/src/sim/workers/workers.ts#L512).

O planejador local descarta expansões fora do raio 8 sem marcar o corte espacial. Quando seu heap esvazia, retorna `unreachable`. Se o A* normal já atingiu o limite de nós, o fallback local pode converter `search-limited` em `no-access`, sem ter explorado o caminho existente.

**Reprodução em Node:** origem `[12,4,12]`, destino `[14,4,12]`, piso abaixo de Y=4 e parede X=13, Z=4..20, Y=4..7, sem ferramenta. A navegação global encontra rota de custo 80 por Z=3. A busca local retorna `unreachable` após 766 operações, pois o desvio sai de seu raio. No runtime com `maxSearchNodes: 4` e `allowDig: true`, o bloqueio final é `no-access`.

**Correção:** registrar cortes de raio e preservar `limited` quando a busca esgotada foi incompleta. Conservar também o limite do A* anterior. Não é necessário remover o limite local; o problema é afirmar ausência de rota sem evidência suficiente.

### 7. Hash não cobre todo estado que decide a execução futura

**Local:** [workers.ts:554](../../../packages/engine/src/sim/workers/workers.ts#L554), [workers.ts:472](../../../packages/engine/src/sim/workers/workers.ts#L472) e [navigation.ts:247](../../../packages/engine/src/sim/navigation/navigation.ts#L247).

O hash omite motivos de bloqueio que controlam repetição da busca. O hash de `PathSearch` também omite seu conjunto `blocked`, usado nos desvios de tráfego.

**Reprodução de simulação:** dois mundos idênticos com uma unidade bloqueada têm hash 2510010294. Alterar somente o motivo interno de uma unidade de `no-access` para `traffic` mantém o hash. No próximo tick ela começa a planejar, enquanto a outra permanece bloqueada. Esse controle interno isolou a sensibilidade do hash; não prova que dois históricos públicos diferentes já produzam tal colisão.

**Reprodução do componente:** buscas idênticas de `[5,4,5]` para `[8,4,5]`, uma bloqueando `[6,4,5]` e outra sem bloqueio, produzem a mesma sequência de valores em `mixState` antes de avançar. Depois encontram custos 20 e 12.

**Correção:** incorporar motivos e obstáculos temporários de forma determinística, com marcadores/comprimentos para estruturas variáveis. Auditar também caminho alternativo e tarefas sintéticas; adicionar testes de sensibilidade. Os casos confirmam cobertura incompleta do hash, não replay não determinístico.

## Melhorias e testes recomendados

1. **Cobrir interação real no E2E:** seleção, giro/arrasto, designação manual, cancelamento, pausa e proxies acima de 24 unidades. O teste atual clica somente demonstrações. Ele verifica voxels e conclusão, mas não compara inventário antes/depois, apesar do nome e da atribuição dessa verificação no relatório anterior. O consumo de estoque é coberto pelos testes de simulação.
2. **Comparar navegação de produção com Dijkstra:** pequenos terrenos gerados com alturas, quedas, cavernas e obstáculos. Os quatro testes atuais não verificam amplamente custo ótimo e conectividade.
3. **Rotacionar/suspender tarefas bloqueadas da fronteira:** 256 tarefas antigas inacessíveis podem impedir qualquer expansão de ordens posteriores, mesmo de prioridade alta. É uma limitação documentada da fronteira atual, mas compromete progresso de obras independentes.
4. **Reduzir reservas provisórias de poses de trabalho:** reservar todas as poses candidatas durante a busca impede outras tarefas próximas de usar posições que acabarão descartadas. Reservar a pose escolhida ou limitar reservas provisórias pode aumentar concorrência.
5. **Precisar o contrato das barreiras de malha:** uma barreira pendente congela todas as unidades visualmente; um chunk com falha permanente pode manter esse congelamento. A versão aceita da fila pode preceder a visibilidade quando há `stagedSources`. Vincular barreiras às unidades afetadas, usar versão efetivamente exibida e definir tratamento de falhas. Não foi montada uma reprodução completa de travamento nesta revisão; é um risco identificado por inspeção.
6. **Atualizar unidades antes de renderizar:** `frame` é emitido depois de `visuals.frame`, introduzindo um frame de atraso para poses/animações da view.
7. **Ampliar o benchmark:** gargalos, obras concorrentes, churn de terreno e tempo até todas as unidades iniciarem/chegarem. Os números atuais descrevem corretamente a amostra curta em terreno plano, mas não bastam para esses cenários.

## Ordem sugerida de correção

Primeiro interação e picking (1–2), depois atribuição/progresso das obras (3–4), segurança do movimento (5), semântica de busca (6) e cobertura do hash (7). Cada correção deve entrar com a reprodução correspondente como teste de regressão. Repetir o E2E manual e os testes de simulação após esse conjunto; medir desempenho novamente se a política de atribuição/reservas mudar.

Limites já declarados de HPA*, WHCA*, engenharia planar e planejamento de andaimes não foram tratados como bugs. Não houve publicação de issues, mensagens externas, commit ou alteração de produção nesta revisão.
