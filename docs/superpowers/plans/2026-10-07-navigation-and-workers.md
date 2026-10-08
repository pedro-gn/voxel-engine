# Plano de entrega: navegação e unidades trabalhadoras

Data: 2026-10-07. Base: [design](../specs/2026-10-07-navigation-and-workers-design.md) e [pesquisa](../research/2026-10-07-navigation-and-workers.md). A base funcional dos incrementos abaixo está entregue na engine e na cena `workers`. Veja o [relatório de implementação e validação](../reviews/2026-10-07-workers-validation.md). O plano preserva verificações e extensões propostas: HPA* global, WHCA*, atribuição espacial com envelhecimento e planejamento geral de andaimes não foram implementados.

## 1. Unidade simulada andando até uma ordem

**Resultado:** spawn de unidade terrestre, ordem de movimento em mapa pequeno com degraus/caverna, parada/cancelamento e bean seguindo poses do worker.

Criar `sim/navigation/` para tipos de perfil/goal/resultado, extração de tiles, transições, heap e busca retomável. Criar `sim/workers/` para store tipado de unidades, ordens e movimento Q8. Integrar por configuração opt-in em `Simulation`, `SimInitOptions` e protocolo. Sem unidades habilitadas, preservar hashes/comportamento existentes e evitar alocação proporcional ao mundo para navegação.

Começar com quatro direções, altura/corpo/apoio, subida de um e queda de até dois. A ordem recebe apenas uma rota completa validada ou aguarda. Usar pool e teto de trabalho desde a primeira busca; extração, arestas e reconstrução também progridem em fatias. Separar `pending`, `limited` e `unreachable`.

Centralizar atualização visual no render loop e usar snapshots inteiros + interpolação. Spawn valida espaço e chão; não nasce no highest column automaticamente quando a ordem aponta para uma caverna. Expor comandos e evento de unidade sem permitir que renderer mova o estado autoritativo.

**Verificação:** mesma rota/custo que Dijkstra em pequenos mapas gerados; rota zero; origem/destino inválidos; dois pisos na mesma coluna; teto baixo; degrau com teto na origem; queda em sentido único; borda/piso finito; cancelamento de busca e de movimento; unidade parada na pausa. Teste integrado da ordem chegando ao destino e do bean apresentando a pose.

## 2. Terreno mutável e perigo observado

**Resultado:** editar um corredor faz a unidade parar/replanejar; remover apoio inicia queda; água/fragmento bloqueiam passagem corretamente.

Adicionar invalidadores de geometria/perigo/trabalho com halos e revisões. Cobrir geração inicial, `replaceColumns`, hooks normais e mudanças quietas da água. Tile reconstruído entra somente após validar suas dependências. IDs locais têm geração; rotas persistem coordenadas. Luz não gera replan.

Acrescentar consultas de água por altura e ocupação varrida de blocos/fragmentos em queda. Política de apoio estrutural pendente começa conservadora; não inventar certificado local que o CollapseSystem ainda não possui. Unidades não alteram o suporte de structural fragments. Resolver corpo ocupado para comandos/fill/regeneração por preflight, antes de escrever.

**Verificação:** nova parede, novo teto, apoio removido, mudança em fronteira e em altura de chunk; alteração distante e luz sem reinício; água no piso inferior apesar da superfície superior seca; inundação durante movimento; fragmento rápido cruzando o corpo; edits na pausa e revalidação ao retomar; regeneração recusada sem efeito parcial quando ocuparia unidade.

## 3. Escavação de um bloco e de uma designação

**Resultado:** selecionar bloco/área produz tarefas; unidade caminha a uma pose alcançável, trabalha durante a duração do material, remove e coleta apenas uma vez.

Adicionar catálogo de trabalho por bloco e perfil/ferramenta. Designações em tiles/bitsets e expansão por fronteira. Implementar work poses com alcance/linha de visão, goal multialvo, claim, prioridade/idade, progresso e motivos de bloqueio. Atribuição usa shortlist espacial e possui teto; não cria busca para cada par unidade/bloco.

Criar escrita condicional interna com retorno transacional. Drops e inventário entram na mesma operação lógica. Validar alvo/claim/alcance/ferramenta/apoio na conclusão. Remoção usa os hooks de água, luz, gravidade e colapso. Planejar túneis pela abertura existente; trabalhar fora de alcance é impossível.

**Verificação:** deslocamento antes de escavar; duração inteira observável; material/ferramenta proibidos; alvo removido ou alterado por jogador; cancelamento no meio do trabalho; uma tarefa reivindicada por duas unidades; teto e apoio perigosos; inventário cheio sem desaparecimento de drops; area grande respeitando expansão/commit cap; tarefa bloqueada acorda após abertura de acesso.

## 4. Construção com materiais e dependências

**Resultado:** blueprint acessível vira blocos colocados na ordem necessária; estoque reduz exatamente pelo que foi construído.

Adicionar ordem/preview de construção, material escolhido, estoque real e reserva. Ordenar dependências de apoio e de acesso; não fechar corredor ou o próprio corpo. Usar mesmo pipeline de work poses/claim/commit. Incluir exemplo de parede, escada e ponte; preservar regra de normal blocks e collapsible blocks.

Andaimes temporários só entram com plano, estoque e tarefas explícitas de desmontagem. Se o plano exige scaffold ainda não suportado pelo incremento, retornar falta de acesso com a necessidade observável; não teleportar nem construir remotamente. Definir reabastecimento simples por comando antes de incorporar depósitos/hauling.

**Verificação:** consumo e reserva; falta de material; alvo já correto sem novo consumo; voxel alterado antes do commit; bloco em queda/fragmento sobre destino; cancelamento devolvendo somente reservas; apoio que cai após colocação; último bloco de espaço fechado acessível; impossibilidade real de completar blueprint reportada.

## 5. Cooperação em movimento e trabalho

**Resultado:** 100 unidades recebem ordens distintas; compartilham corredor e área de obra com espera/cessão de passagem, sem sobreposição ou duplicação de trabalho.

Índice espacial de ocupação + tabela temporal de intervalos. Reservar corpo, aresta inversa, corredor e pose de trabalho. Unidades paradas continuam ocupantes após o horizonte. Claims e reservas de materiais/transporte são distintos. Destino coletivo escolhe um conjunto de posições distribuídas.

Introduzir arbitragem estável por prioridade/idade, espera, recuo para posição livre e detecção de ausência de progresso. Comparar planejamento em janela nos gargalos; inicialmente 32 ticks, com custos/durações reais. Limitar reservas e buscas. Uma configuração impossível retorna `traffic`; não alegar que WHCA* garante resolver qualquer conjunto de agentes.

**Verificação:** mesma célula, troca de células, cruzamento, fila de corredor, sentidos opostos com/sem espaço de recuo, velocidades/perfis diferentes, trabalhador parado bloqueando passagem, destino já ocupado, cancelamento/despawn liberando claims e reservas, replay com prioridades envelhecendo.

## 6. Engenharia local para alcançar destinos

**Resultado:** com política habilitada, unidade escolhe contorno existente ou realiza pequenas escavações/construções que habilitam a rota, respeitando estoque.

Planner local com ações explícitas e overlay. Estado inclui material restante; manter rótulos distintos onde recursos ou edits diferem. Limitar raio, edits e estados. Plano resulta em tasks/actions; terreno futuro não entra como verdadeiro no nav cache. Executar prefixo e observar física antes de continuar.

Uma ordem comum começa com essa política desligada. Obras extensas usam designação/frontier e ligações de acesso planejadas; não uma expansão global combinatória. Esgotamento dos limites responde `search-limited`, preservando capacidade de aumentar o escopo por configuração/ordem apropriada.

**Verificação:** reutilizar os sete fixtures de ações da pesquisa com corpo 3D e física; desvio mais barato que túnel; túnel forçado; ponte com/sem material; chegada mais cara que preserva estoque necessário; apoio planejado que cai; limite atingido sem falso `unreachable`; ordem cancelada não continua modificando terreno.

## 7. Hierarquia e manutenção local para mundos grandes

**Resultado:** navegação longa e rajadas de edição possuem latência/memória aceitáveis sem afetar correção dos caminhos.

Comparar tamanhos de tiles 8³/16³/32³. Medir construção fria, tile editado e suas fronteiras, tempestade de replan e refinamento. Criar portais por camada/transição e travessias dirigidas; intrarregião sob demanda com revisão. Não mesclar componentes apenas por compartilharem chunk.

Comparar A* com hierarquia no mesmo conjunto de origens/destinos, incluindo aberturas estreitas e múltiplos andares. Registrar custo subótimo e nenhum falso resultado de alcance. Manter fallback exato nos testes; cache sujo/incompleto não prova ausência de rota. Pool/eviction seguem cap de memória e cancelamento explícito.

Se muitos agentes compartilham depósito/destino, experimentar campo Dijkstra reverso. Se destinos persistentes com pequenas alterações dominam a carga, comparar D* Lite contra replans locais. Escolher por custo integrado, incluindo atualização/memória, não pelo nome do algoritmo.

**Verificação:** custos contra referência pequena; completude de portais; queda dirigida; split/merge de regiões após obra; halo/fronteiras; revisões em mudança contínua sem fallback ilimitado; cold start separado; progresso justo de buscas sob rajada de ordens.

## 8. Cena final, soak e limites publicados

**Resultado:** `?scene=workers` demonstra deslocamento, túnel, ponte/escada, cooperação e reação a física. HUD distingue ordem aceita, execução, conclusão e bloqueio.

Criar controles de seleção/designação e preview. Mantêm modo de edição direta existente. Mostrar progresso/material/causa de bloqueio. Overlay de navegação/reservas só da vizinhança selecionada. Validar camera/picking e animação fallback do GLB. Publicar deltas/poses compactos, lifetime de buffers e handoff visual por versões de terreno.

Soak com 1/100/1.000 unidades, mundo 256² e padrão 1024² × 128, água e colapso ligados/desligados. Roteiro fixa seed, ordens, edições, perfil, estoque e duração. Medir sim p50/p95/p99/max, fase de unidades, reconstrução/busca, latência de primeira ação, memória, payload e render CPU/GPU/FPS separadamente.

Primeiros alvos propostos: sim tick p95 ≤ 10 ms e ordem curta aquecida p95 ≤ 250 ms com 100 unidades no hardware registrado. Medir 1.000 para definir limite/admissão; se renderização dominar, LOD/proxies antes de multiplicar mixers. Reportar casos sem solução física/recursos separadamente de falhas do algoritmo.

Reexecutar testes/typecheck e E2E de água, colapso e editor. Registrar limites e escolhas finais em relatório; atualizar design/glossário/ADR somente com decisões efetivamente adotadas. Concluir esta fase apenas com cenário integrado, orçamento respeitado e dados completos, não apenas com A* isolado aprovado.

## Artefatos já entregues nesta pesquisa

- `packages/engine/bench/navigation.node.mjs`: grafo estático com leituras de `ChunkStore`, três estratégias, Dijkstra de referência, retomada e planner exato de ações pequeno.
- `docs/superpowers/research/2026-10-07-navigation-results.json`: hardware/runtime, medições e resultados verificáveis.
- Pesquisa e design linkados no início deste plano. Nenhum comportamento de produção foi alterado por estes artefatos.
