# Pesquisa: pathfinding, escavação e construção por unidades

Data: 2026-10-07. Projeto: Elovox. Este documento registra a pesquisa que orientou a implementação. A base funcional já está instalada no runtime; veja o [relatório de implementação e validação](../reviews/2026-10-07-workers-validation.md) para capacidades, medições e limites atuais.

## Recomendação

Usar um **grafo esparso de posições de apoio, com múltiplos andares**, A* retomável, cache local de transições e invalidação por mudanças relevantes. Executar no sim worker existente. Acrescentar uma hierarquia de regiões/portais para rotas longas, reservas de ocupação para várias unidades e um módulo de tarefas que execute escavação/construção por ações condicionais.

O terreno é a fonte da geometria. A unidade ocupa volume, necessita de apoio e executa ações com duração. Não é suficiente procurar uma lista de voxels vazios: isso permitiria atravessar tetos baixos, cair de alturas proibidas, gastar materiais inexistentes ou trabalhar dentro do bloco que precisa remover.

Esta é a escolha mais justificada pelo código e pelos experimentos desta etapa. Ainda não constitui uma comparação de todos os algoritmos nem uma medição do sistema completo com milhares de unidades.

## Fontes primárias consultadas

1. [Botea, Müller e Schaeffer — Near Optimal Hierarchical Path-Finding, 2004](https://webdocs.cs.ualberta.ca/~jonathan/PREVIOUS/Papers/Papers/jogd.pdf). HPA* divide mapas em clusters, reutiliza travessias internas e refina a rota abstrata. Alterações locais exigem reconstruir ligações internas e entre clusters afetados. O artigo mede ganhos em mapas 2D; seus números não são previsão de desempenho para Elovox. Aplicação proposta: hierarquia sobre superfícies 3D, após validar A* e manutenção local.
2. [Koenig e Likhachev — D* Lite, 2002](https://idm-lab.org/bib/abstracts/papers/aaai02b.pdf). Busca incremental reutiliza trabalho entre problemas relacionados quando custos/arestas mudam. Aplicação possível: trajetos repetidos até destinos persistentes. Inferência para este projeto: manter estado incremental por trabalhador pode custar mais memória e manutenção que A* local com cache, sobretudo quando tarefas e destinos mudam. A hipótese precisa de benchmark comparativo antes da adoção.
3. [Silver — Cooperative Pathfinding, 2005](https://ojs.aaai.org/index.php/AIIDE/article/download/18726/18503/22369). CA* usa espaço-tempo, espera e reservas; WHCA* limita a janela temporal. Planejamento priorizado não resolve todas as instâncias e depende da ordem dos agentes. Aplicação proposta: reservas curtas e tratamento explícito de congestionamento, com WHCA* em gargalos quando necessário.
4. [Recast Navigation — documentação dos mantenedores](https://recastnav.com/), [FAQ sobre tiles e reconstrução em runtime](https://recastnav.com/md_Docs_2__3__FAQ.html). Recast produz navmeshes a partir de geometria e suporta mapas dinâmicos em tiles. Portanto navmesh não é incompatível com terreno editável. Inferência para Elovox: derivar diretamente um grafo dos blocos evita introduzir outra representação geométrica e sua manutenção antes de termos um executor de ações. Recast permanece uma alternativa para formas não cúbicas ou locomoção mais contínua.
5. [Harabor — Jump Point Search, explicação do autor](https://harablog.wordpress.com/2011/09/07/jump-point-search/). O JPS clássico explora simetrias de grades com custos uniformes. Escavação, materiais, subida e água quebram essas premissas. Isso não impede variantes especializadas; impede aplicar as regras clássicas indiscriminadamente ao nosso grafo de ações.
6. [PrismarineJS — mineflayer-pathfinder, documentação](https://github.com/PrismarineJS/mineflayer-pathfinder), [implementação dos movimentos](https://github.com/PrismarineJS/mineflayer-pathfinder/blob/master/lib/movements.js). O projeto separa geração de movimentos, metas, busca e execução; movimentos carregam blocos a remover/colocar e estoque restante. A documentação distingue sucesso, progresso parcial, timeout e ausência de rota. Serve de referência prática; sua interface depende do ecossistema Minecraft e não é um módulo intercambiável para Elovox.
7. [Baritone — recursos descritos pelos mantenedores](https://github.com/cabaletta/baritone/blob/master/FEATURES.md). Considera ferramentas e escavação no custo de movimento, usa cache de chunks e planeja segmentos. Aplicação proposta: custo de trabalho por material/ferramenta e refinamento curto de rota. Planejar modificações não autoriza executá-las sem validar terreno e recursos atuais.

As decisões abaixo são inferências de engenharia para este repositório, não requisitos atribuídos aos artigos. Nenhum código desses projetos foi copiado.

## O que existe no repositório

| Ponto | Comportamento observado | Consequência |
|---|---|---|
| `world/layout.ts` | Chunks 32³; mundo padrão 1024 × 128 × 1024 | Scratch denso por voxel e por unidade é caro |
| `sim/simHost.ts` | Simulação padrão de 20 Hz | Unidades devem usar ticks e movimento determinístico |
| `sim/simulation.ts` | Escritor único; comandos, regras, gravidade, água, tarefas computacionais, colapso, luz e commit | Reutilizar os hooks de escrita; inserir fases explícitas de unidades |
| `Simulation.epochs` | Avança em escritas de voxels, inclusive espelho de água | Não serve sozinho como versão de navegabilidade |
| `ChunkStore.versions` | Seqlocks também mudam com luz e escritas quietas | Não confundir consistência de memória/mesh com geometria de navegação |
| `sim/jobs.ts` | FIFO; após três reinícios usa `Infinity`; `finish()` sem orçamento | Não reutilizar esse escalonamento sem mudanças para pathfinding |
| `blocks/registry.ts` | Tabelas tipadas de sólido, líquido, queda individual e colapso | Falta política de escavação, duração, ferramenta e materiais |
| `sim/water/columns.ts`, `under.ts` | Água superior e segmentos subterrâneos com profundidade inteira | Perigo deve consultar água autoritativa por altura, incluindo cavernas |
| `sim/collapse.ts` | Fragmentos saem da grade; ocupação móvel por coluna; verificações podem estar pendentes | Ar na grade não prova que uma passagem está livre; acrescentar consulta de estabilidade/perigo |
| `sim/gravity.ts` | Blocos em queda possuem Q8 e índice por coluna | Reutilizar modelo numérico; acrescentar consulta de interseção varrida |
| `apps/sandbox/src/character.ts` | Bean visual com `idle`/`walk`; posição inicial obtida por raycast; RAF próprio | Ainda não existe entidade simulada, colisão, ordem ou tarefa; renderer deve seguir snapshots |

O [ADR-0001](../../adr/0001-opt-in-structural-connectivity.md) continua válido: normal blocks e collapsible blocks mantêm suas regras. Navegação não transforma blocos normais em indestrutíveis, nem habilita colapso em todo o terreno. Precisar de uma ferramenta para escavar é outra propriedade.

## Experimento reproduzível

```powershell
node packages/engine/bench/navigation.node.mjs
```

Código: [navigation.node.mjs](../../../packages/engine/bench/navigation.node.mjs). Dados registrados: [JSON](2026-10-07-navigation-results.json).

Node v24.5.0, AMD Ryzen 5 5600. Cinco warmups e 21 amostras por estratégia/caso, com ordem das estratégias rotacionada. Mundo real de `ChunkStore`, altura 64. Cada caso repete a mesma consulta: isso mede consultas aquecidas em fixtures controladas, não uma distribuição de ordens de um jogo. Primeira consulta, extração e criação de arestas são registradas separadamente. A extração inteira ainda é síncrona no protótipo.

Perfil: duas células de altura, quatro direções, subida de um bloco e descida de até dois. Custos inteiros: andar 4, subir 6, descer 4 + queda. Heurística: distância Manhattan horizontal × 4, um limite inferior consistente. Todas as estratégias usam o mesmo heap tipado e desempate; duas leem arestas em cache, a terceira valida vizinhos com leituras de voxels. Mesmo a variante com leituras vivas usa o índice de posições já extraído: não é um A* sem índice.

| Cenário | Nós de apoio | Construção do grafo | `Map` + cache p95 | Tipado + cache p50 / p95 | Tipado + voxels p95 |
|---|---:|---:|---:|---:|---:|
| Aberto 256² | 65.536 | 128,915 ms | 0,643 ms | 0,203 / 0,462 ms | 0,543 ms |
| Degraus 128² | 16.384 | 31,324 ms | 13,740 ms | 8,585 / 12,022 ms | 13,122 ms |
| Dois andares 128² | 31.744 | 38,230 ms | 0,323 ms | 0,102 / 0,129 ms | 0,180 ms |
| Labirinto 128² | 16.384 | 32,683 ms | 7,815 ms | 4,100 / 6,764 ms | 8,954 ms |
| Inacessível 128² | 16.384 | 32,073 ms | 7,209 ms | 4,854 / 5,962 ms | 7,891 ms |

O caso de degraus expande 15.172 nós: a heurística horizontal é correta, mas fraca quando subir é mais caro. Além de cache e tipagem, precisamos de heurísticas melhores/hierarquia e de rejeição de componentes desconectados no modo de locomoção sem obras. A construção global de 256² já custa ~129 ms. Reconstruí-la a cada escavação inviabilizaria a interação.

As buscas divididas em 256 retiradas do heap preservam o mesmo caminho. Nos casos difíceis, as fatias tiveram p95 de 0,102–0,112 ms nesta execução; a maior fatia foi 1,409 ms. Foram necessárias 96 fatias nos degraus, 74 no labirinto e 62 no inacessível. Se executássemos apenas uma fatia por tick a 20 Hz, os degraus demorariam 4,8 s: orçamento baixo precisa ser acompanhado por hierarquia, prioridades e distribuição justa. Fatias curtas não bastam para baixa latência.

O limite do protótipo conta retiradas do heap; cada uma avalia no máximo quatro vizinhos com altura/queda constantes. Reconstrução do caminho, criação do grafo e crescimento de buffers não estão completamente fatiados. O sistema de produção precisa contabilizá-los também. Não há garantia de wall time sob GC ou disputa de CPU.

### Memória

- Mundo padrão: 134.217.728 voxels. Quatro tabelas de 4 bytes por voxel exigiriam **2 GiB por contexto de busca**, antes de heap e mundo.
- Uma superfície plana de 1024²: 1.048.576 posições; scratch de 16 bytes exige **16 MiB por contexto**, ainda grande para criar um por unidade.
- Aberto 256²: grafo tipado retido de **1,75 MiB**, scratch de **1 MiB**, heap aquecido de **16 KiB**. O grafo inclui posição, offsets de coluna, quatro arestas e custos. Não inclui dados do mundo, listas temporárias de construção, objetos JS, renderização ou caches de tarefas.
- `Map` reporta número de entradas, não um tamanho inventado em bytes. Scratch tipado denso paga por todos os nós mesmo em uma consulta curta. Para produção: páginas por região e poucos contextos ativos reciclados, com orçamento global de memória.

### Verificações executadas pelo protótipo

64 pares origem/destino comparados a Dijkstra no mesmo grafo, três estratégias e fatias de três retiradas. Isso verifica custo ótimo da busca nesse grafo; não é uma prova independente de toda a geometria. Fixtures adicionais verificam subida, teto sobre a origem, descida dirigida, limite de queda, bordas e piso finito. A extração preserva os dois andares da mesma coluna.

O segundo experimento usa Dijkstra exato em mapas planares minúsculos, com estado `(posição, estoque, blocos removidos, apoios colocados)`. Um executor independente revalida e reproduz cada ação. Casos aprovados: preferir desvio existente, abrir túnel com dois blocos de altura, proibir escavação, construir ponte de dois blocos, rejeitar estoque insuficiente, preservar material via desvio e proibir construção.

O desvio para preservar material é relevante: chegar mais barato a uma posição tendo gasto o único bloco disponível não domina uma chegada mais cara que ainda consegue construir o trecho final. Colapsar ambos em um único estado por posição pode produzir um falso `unreachable`.

Não foram medidos HPA*, D* Lite, manutenção dinâmica, transporte entre workers, água, colapso, colisão entre unidades, animação ou FPS. O protótipo de ações não simula ferramentas, estruturas, física ou colisão 3D; testa explicitamente custos, ordem de execução, capacidades e conservação do estoque.

## Alternativas e decisão

| Técnica | Adequação | Decisão proposta |
|---|---|---|
| A* sobre todos os voxels vazios | Muito ar inútil; apoio/volume ainda precisam ser modelados | Evitar como representação principal de unidades terrestres |
| Heightmap com apenas um Y por X/Z | Muito compacto; perde cavernas e pontes | Evitar; manter múltiplas posições por coluna |
| Grafo de apoio + A* retomável | Corresponde a blocos editáveis e permite ações tipadas | Base da primeira implementação |
| Hierarquia por regiões/portais | Reduz consultas longas; acrescenta custo de manutenção | Próximo incremento obrigatório para escala, com comparação medida |
| Recast/Detour | Solução real para navmesh dinâmica; outra representação e integração | Reavaliar para geometria contínua ou formas não cúbicas |
| D* Lite | Reutiliza buscas relacionadas; estado por destino/agente | Experimento posterior para rotas persistentes |
| JPS clássico | Custos uniformes e simetria | Não aplicar diretamente a ações com custos diferentes |
| Campo de distância compartilhado | Bom para muitos agentes indo ao mesmo conjunto de destinos | Opcional para depósitos/agrupamento; usar Dijkstra reverso com custos variados |
| Reservas + planejamento em janela | Coordena gargalos e ocupação futura | Necessário para múltiplas unidades; não promete solução global em toda instância |
| Planner global de toda modificação possível | Estado inclui mundo modificado, materiais e ações; crescimento combinatório | Usar tarefas explícitas e lookahead local limitado, reportando limites |

## Próximo resultado implementável

A [proposta de arquitetura](../specs/2026-10-07-navigation-and-workers-design.md) define navegação, movimento, ações, tarefas, recursos, concorrência e integração. O [plano de entrega](../plans/2026-10-07-navigation-and-workers.md) organiza incrementos executáveis e critérios de conclusão. Os defaults sugeridos são configuráveis e ainda não foram validados como desempenho de produção.

## Validação desta entrega

Protótipo executado com todas as assertions aprovadas. `npm run typecheck` passou nos quatro workspaces. `npm test` passou em 118 arquivos: 1.113 testes aprovados e dois casos de falha esperada já existentes. O primeiro lançamento de Vitest encontrou `EPERM` ao renomear arquivos na pasta temporária isolada do ambiente; o lançamento aprovado definiu `TEMP`/`TMP` em `node_modules/.cache/navigation-test-tmp`, dentro do workspace, sem alterar a configuração do projeto. Esses checks verificam os artefatos e regressões existentes; não validam unidades de produção, pois elas ainda são uma proposta.
