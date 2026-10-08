# Movimento contínuo dos workers

Data: 2026-10-07. Estudo, implementação e validação da pausa entre pontos e do deslocamento preso aos centros dos voxels.

## Diagnóstico reproduzido

Dois testes sobre a `Simulation` real falharam antes da correção:

```powershell
npm run test -w @elovox/engine -- test/workers.test.ts -t 'keeps advancing|walks directly off'
```

O primeiro registrou deslocamentos Q8 de `64,64,0,64,64,64,0,...` durante uma caminhada sem obstáculos. O executor terminava um movimento e encerrava o tick; no seguinte, somente iniciava a próxima transição. O segundo registrou zero ticks com deslocamento simultâneo em X e Z em um piso aberto.

As hipóteses verificadas foram a troca de trecho consumir um tick sem movimento, a execução exigir cada aresta ortogonal do grafo e a orientação visual reforçar os trancos. Remover isoladamente o retorno após concluir um movimento fez o primeiro teste passar; o teste de diagonal continuou falhando. A rotação cardinal também foi substituída, com uma regressão que detectou o personagem voltando a um eixo depois de parar numa diagonal.

## Alternativas e escolha

| Abordagem | Aplicação aqui |
|---|---|
| A* atual com simplificação por visibilidade | Mantém apoio, múltiplos pisos, cache, invalidação e engenharia. Remove pontos intermediários desnecessários na execução. Foi a opção implementada. |
| Theta* / Lazy Theta* | Faz a própria busca considerar ligações em qualquer ângulo. Exigiria adaptar custos, heurística e verificações volumétricas ao terreno e às ações atuais. Pode melhorar a escolha de rotas; fica para uma medição específica. |
| Navmesh / corredor Detour | Oferece uma representação adequada a movimento contínuo, mas acrescentaria extração e manutenção de outra geometria navegável. Não é necessário para corrigir os dois sintomas reproduzidos. |
| Curvas ou steering aplicados à apresentação | Precisariam seguir um corredor validado para preservar colisões e apoio. Rotação suave é visual; a trajetória continua autoritativa na simulação. |

[Theta*: Any-Angle Path Planning on Grids](https://arxiv.org/abs/1401.3843) descreve busca sem limitar as ligações às arestas da grade. A documentação do [corredor Detour/Recast](https://recastnav.com/classdtPathCorridor.html) inclui otimização por visibilidade e movimento dentro do corredor. A escolha acima é uma inferência de engenharia para este repositório, não uma implementação desses algoritmos nem código copiado desses projetos.

## Comportamento implementado

- Terminar um trecho permite preparar o próximo e atualizar o estado no mesmo tick. Não há tick parado obrigatório nem troca intermediária para animação idle.
- O executor considera até 32 nós futuros de mesma altura, com até oito tentativas de visibilidade antes da aresta comum. Quando há passagem, anda diretamente para um ponto posterior, incluindo diagonais e poses fora do centro dos voxels.
- O teste de passagem usa o corpo inteiro, com largura 0,75 e altura 2. Retângulos curtos varridos a cada 1/8 de bloco cobrem conservadoramente quinas. Cada coluna de contato precisa ter apoio e respeitar segurança, água e reservas de construção.
- Movimento plano normaliza o tempo pela distância euclidiana, com teto nominal de 64 Q8/tick, ou 5 blocos/s a 20 Hz. O arredondamento para ticks inteiros pode reduzir ligeiramente a velocidade média de um trecho; não há ganho de velocidade por andar na diagonal.
- A reserva plana cobre o volume varrido do próximo tick. Um atalho longo não impede edições ou tráfego por toda sua extensão. Apoio, obstáculos e perigos são revalidados antes de avançar. Subidas, descidas e engenharia mantêm suas transições específicas.
- Em encontros frontais, uma prioridade estável permite que a unidade mais nova procure um desvio enquanto a mais antiga aguarda. Unidades continuam sem atravessar outras unidades; não há garantia geral de resolver todos os gargalos.
- Cancelar uma caminhada plana para na pose atual. Uma nova ordem começa dessa pose, inclusive quando o destino é o centro da célula atual. Transições verticais terminam de modo compatível com as regras existentes.
- A view calcula a orientação pelo deslocamento apresentado, gira pelo arco mais curto e preserva a direção ao parar. Idle/walk usam transição de 120 ms; pausa congela o mixer e a rotação. O protocolo de poses e seus 36 bytes por unidade foram preservados.
- O hash inclui o cursor de conclusão do trecho suavizado; replays idênticos continuam determinísticos.

Código principal: `packages/engine/src/sim/workers/workers.ts`, `walkSweep.ts` e `apps/sandbox/src/workersView.ts`. O ADR de navegação foi atualizado para distinguir reservas por tick no piso plano das reservas de transição vertical.

## Validação

As regressões cobrem continuidade entre pontos, diagonal direta, velocidade e poses fora da grade, corpo junto a parede alta, piso estreito em L, cancelamento e nova ordem, parede inserida durante um atalho, centralização após parada e orientação visual após movimento diagonal.

Comandos:

```powershell
npm run typecheck
npm run build -w @elovox/sandbox
npm run test --workspaces --if-present -- --testTimeout=30000 --maxWorkers=4
# E2E_CHANNEL=msedge, E2E_PORT=5196, E2E_PREVIEW=1
npm run e2e -w @elovox/sandbox -- workers.spec.ts collapse.spec.ts caves.spec.ts smoke.spec.ts
node --experimental-strip-types packages/engine/bench/workers.node.ts
```

Resultados finais: typecheck dos quatro workspaces e build aprovados; 121 arquivos de teste, 1.176 casos aprovados e duas falhas esperadas já existentes; 14 cenários de Playwright no Edge aprovados, incluindo workers, colapso, cavernas e smoke. São nove regressões de Vitest adicionais nesta rodada. O build mantém o aviso existente de bundle acima de 500 kB.

O cenário novo de navegador percorreu os 10 blocos da diagonal `(12,27) → (20,33)` sem ticks de caminhada parados e verificou a orientação do modelo ao chegar. Uma medição adicional na Simulation percorreu `(5,5) → (12,8)` em 31 ticks com movimento diagonal: 7,61595 blocos, frente aos 10 blocos da rota ortogonal, com zero ticks parados durante a caminhada. O print do navegador foi inspecionado em `apps/sandbox/test-results/workers-smooth-diagonal.png`. Os cenários de obras verificaram escavação, construção e inventário.

Os comandos de Vitest usaram TEMP/TMP dentro de `node_modules/.cache/navigation-test-tmp`. Build e Playwright executaram fora do sandbox após restrições do ambiente ao resolver arquivos/iniciar conexão local. `git diff --check` e a verificação dos arquivos novos não encontraram whitespace adicional; não há logs temporários de diagnóstico.

## Custo e limites

Resultados do ensaio completo de ticks: [JSON](2026-10-07-workers-smooth-results.json). Protocolo existente: Node v24.5.0, Ryzen 5 5600, mundo 256 × 128 × 256, orçamento de busca 4.096, 240 ticks após ordem coletiva. A medição não inclui renderização nem transporte entre workers; memória de navegação contabiliza somente arrays tipados.

| Unidades | Movimento p50 (ms) | p95 (ms) | p99 (ms) | Máximo (ms) | Iniciaram em 240 ticks |
|---:|---:|---:|---:|---:|---:|
| 1 | 0,021 | 0,065 | 0,868 | 4,442 | 1 |
| 100 | 1,209 | 2,204 | 4,070 | 5,107 | 100 |
| 1.000 | 3,019 | 4,522 | 5,552 | 9,607 | 610 |

A rodada final foi feita sem build/testes concorrentes. Para 1.000 unidades, o pico dos arrays de navegação permanece em 7.362.560 bytes, e as poses em 36.000 bytes por publicação. Ao fim havia 117 unidades caminhando e 883 planejando; o ensaio não demonstra chegada de todas nem FPS com mil modelos. As verificações extras têm custo: o p95 histórico dessa carga era 3,037 ms na rodada anterior. As execuções não constituem uma comparação controlada, mas mostram a necessidade de manter os limites da suavização e não presumir custo zero.

A suavização acrescenta verificações de corpo e apoio. A primeira versão repetia testes longos enquanto aguardava tráfego; o executor agora pula essas tentativas durante a espera e segue a arbitragem local. O orçamento de busca continua respeitado, e o lookahead e o número de tentativas de suavização têm limites próprios.

Essa otimização é local. Não garante o menor caminho euclidiano global e não arredonda todas as quinas com splines. Em passagens estreitas, escadas ou obra que altera o terreno, centros de células e transições discretas continuam necessários. A sincronização visual com malhas mantém as barreiras globais existentes; uma obra pode ainda congelar apresentação enquanto a malha correspondente é atualizada.

Se outra rodada for necessária, medir curvas de trajetória dentro de corredores seguros e melhor escolha de rotas em qualquer ângulo, antes de ampliar o lookahead ou substituir a representação de navegação.
