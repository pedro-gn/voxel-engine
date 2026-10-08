# Navegação e unidades: implementação e validação

Data: 2026-10-07. Implementação opt-in na engine e demonstração na cena `workers`. A [pesquisa](../research/2026-10-07-navigation-and-workers.md) e o [design original](../specs/2026-10-07-navigation-and-workers-design.md) explicam as alternativas consideradas; este documento descreve o código efetivamente entregue.

Atualização após revisão: [consertos, regressões e medições atuais](2026-10-07-workers-fixes.md). Os números abaixo registram a validação inicial; o relatório novo contém a rodada posterior às correções.

## Comportamento entregue

- Unidades simuladas recebem movimento individual/coletivo, parada, seleção, escavação e construção de blocos ou áreas. A formação coletiva distribui destinos com espaço entre unidades.
- Movimento Q8 determinístico, corpo de 2 blocos de altura e 0,75 de largura, apoio, cavernas e múltiplos pisos, subida de 1 bloco, descida voluntária de até 2 e queda física quando o apoio desaparece.
- A* retomável sobre posições de apoio, cache esparso em regiões 16³, invalidação com halo, quatro buscas ativas, orçamento compartilhado e reconstrução incremental. Atalhos retos até fronteiras de regiões aceleram rotas longas, preservando arestas comuns e todos os passos executáveis.
- Reservas exclusivas do volume varrido do próximo movimento, espera, recálculo e desvio local. Unidades não atravessam outras unidades nem trocam de lugar atravessando o mesmo corredor.
- Tarefas possuem alvo e posição de trabalho exclusivos, duração por material, ferramenta, alcance e linha de visão. Construção consome estoque; escavação produz um único drop. Estoque cheio mantém o excedente no mundo; coleta alcança pilhas próximas desobstruídas.
- Escritas condicionais passam pelos hooks existentes de água, gravidade, colapso, luz e commit. Um alvo removido ou alterado não gera recurso duplicado. Fill/regeneração que inseririam sólidos no corpo de unidades são recusados antes de qualquer escrita.
- Água por altura, inclusive segmentos subterrâneos, e volumes varridos de blocos/fragmentos em queda são consultados na execução. Edições relevantes despertam trabalho bloqueado e invalidam navegação; mudanças de luz não invalidam o grafo.
- Planejamento opcional de passagens simula escavação e colocação de piso, mantendo rótulos distintos de estoque e capacidade. Planejar não modifica o mundo; cada ação é revalidada antes da execução.
- Pausa congela simulação e animações. Parar uma unidade impede que ela reassuma imediatamente uma obra pendente; nova ordem explícita a disponibiliza novamente.
- Publicação de poses compactas, detalhes alterados, deltas de pilhas e versões de chunks. O renderer aguarda as malhas das alterações correspondentes, interpola poses e centraliza animações no loop de frames. Até 24 unidades usam o modelo animado; acima disso, a cena usa proxies instanciados.

Estados distinguem planejamento, movimento, trabalho, queda e bloqueio. Motivos incluem falta de acesso, ferramenta, material, segurança, congestionamento, limite de busca e mudança do alvo.

## Experimentar

Execute `npm run dev` e abra `http://localhost:5173/?scene=workers`. A cena nasce com oito unidades, ferramentas e estoque para as demonstrações.

1. Use **Abrir túnel**, **Montar ponte** e **Erguer parede** para executar obras reais.
2. Clique numa unidade para selecionar; Shift adiciona à seleção; clique direito no chão dá uma ordem de movimento.
3. Selecione escavar/construir e clique no alvo. Shift + segundo clique designa uma área. Material e prioridade ficam no painel.
4. A opção **Abrir passagem ao mover** permite escavação e piso com o material selecionado dentro dos limites do planejador local.
5. Os controles permitem selecionar todas, parar unidades, cancelar obras, adicionar material, coletar excedente próximo e pausar.

## Configuração e comandos

`SimulationOptions.workers` / `SimInitOptions.workers` habilitam o sistema. Blocos ausentes do catálogo de trabalho não podem ser escavados/construídos pelas unidades.

```ts
workers: {
  maxUnits: 1000,
  searchCap: 4096,
  materials: {
    stone: { digTicks: 20, buildTicks: 12, tool: 'pick' },
    planks: { digTicks: 8, buildTicks: 10 },
  },
}
```

Defaults da engine: 1.000 unidades, 4.096 operações de busca/tick, 16.384 nós/busca, 16 unidades consideradas para atribuição/tick, 16 commits de trabalho/tick, 128 ordens e inventário de 512 itens. A cena de demonstração usa `searchCap: 8192`. A fronteira de trabalho contém até 256 tarefas; expande até 256 candidatos/tick e aceita até 1.048.576 voxels por designação.

Comandos enviados por `engine.submit`:

```ts
engine.submit({ type: 'unitSpawn', pos: [12, 5, 27], tools: ['pick'],
  stock: [{ block: engine.blocks.id('planks'), count: 32 }] })
engine.submit({ type: 'unitMove', ids: [1], pos: [40, 5, 30] })
engine.submit({ type: 'workDig', min: [22, 5, 29], max: [26, 6, 29], priority: 128 })
engine.submit({ type: 'workBuild', min: [42, 4, 30], max: [46, 4, 30],
  voxel: engine.blocks.id('planks') })
```

`ids` opcional em obras restringe executores. `allowDig` e `buildBlock` em `unitMove` habilitam engenharia de passagem. `unitStock` adiciona material; `unitCollect` recolhe excedente próximo; `unitCancel` interrompe e torna as unidades indisponíveis para atribuição automática. Uma nova ordem de movimento ou obra correspondente as reativa. `workCancel` cancela a designação; `unitDespawn` remove unidades.

`engine.on('workers', callback)` recebe `WorkerTick`. `poses` contém todos os IDs vivos, com stride 9: `[id,x256,y256,z256,facing,stateCode,order,progress,duration]`. `details` contém somente unidades alteradas; o consumidor mantém um mapa e remove IDs ausentes de `poses`. `drops` são deltas persistentes, com `count: 0` removendo uma pilha. `engine.workers` é a última publicação, não um estado completo de todos os detalhes ou pilhas.

## Medição no runtime

Comando: `node --experimental-strip-types packages/engine/bench/workers.node.ts`. Resultado completo: [JSON](../research/2026-10-07-workers-results.json).

Node v24.5.0, AMD Ryzen 5 5600, mundo 256 × 128 × 256, piso plano, orçamento 4.096. Foram medidos ticks completos de `Simulation`, incluindo publicação, luz e commit; buscas inicialmente frias, tráfego e reconstrução entram na amostra. Sem GPU ou transporte entre workers. São 100 amostras ociosas após aquecimento e 240 ticks após a ordem coletiva, equivalentes a 12 segundos de simulação a 20 Hz.

| Unidades | Ocioso p95 (ms) | Ordem coletiva p50 (ms) | p95 (ms) | p99 (ms) | Máximo (ms) | Iniciaram movimento em 240 ticks |
|---:|---:|---:|---:|---:|---:|---:|
| 0, sistema desabilitado | 0,017 | — | — | — | — | — |
| 1 | 0,044 | 0,040 | 0,124 | 0,655 | 7,938 | 1 |
| 100 | 0,128 | 0,389 | 2,091 | 3,671 | 7,974 | 100 |
| 1.000 | 0,459 | 1,886 | 3,915 | 6,518 | 17,527 | 610 |

Para 1.000 unidades, pico de arrays tipados de navegação de 7.362.560 bytes (~7,02 MiB); poses ocupam 36.000 bytes/publicação. Essa memória exclui mapas/objetos JavaScript, mundo, unidades, renderização e transporte. Ao fim da amostra havia 106 unidades andando e 894 planejando. A medição não afirma que todas chegaram, que congestionamento sempre se resolve ou que 1.000 modelos animados mantêm determinado FPS. O orçamento controla o custo por tick com um compromisso explícito de latência de início; picos continuam possíveis.

## Validação

Resultados finais:

| Verificação | Resultado |
|---|---|
| `npm run typecheck` | Quatro workspaces aprovados |
| `npm run build -w @elovox/sandbox` | Build de produção aprovado; aviso de bundle maior que 500 kB |
| `npm run test --workspaces --if-present -- --testTimeout=30000 --maxWorkers=4` | 120 arquivos aprovados; 1.146 casos passaram e 2 falhas esperadas existentes |
| Novos testes `navigation.test.ts` e `workers.test.ts` | 33 casos passaram, incluídos na execução completa |
| Playwright: workers, collapse, caves e smoke | 12 testes passaram durante a integração |
| Playwright final: `workers.spec.ts`, build de produção, Edge | 1 teste passou, 44,6 segundos |
| `git diff --check` | Sem erros de whitespace |

Para a suíte local, `TEMP` e `TMP` apontaram para `node_modules/.cache/navigation-test-tmp` dentro do workspace, devido às permissões do sandbox. O timeout de 30 segundos foi passado somente pela CLI: uma execução anterior atingiu o limite padrão de 5 segundos no teste existente de brush semeado do terrain-editor sob carga. Código e configuração desse teste não foram alterados.

A suíte de unidades/navegação cobre movimento, portais, pisos, invalidação, recursos, ferramenta, escrita atômica, cancelamento, determinismo, pausa, tráfego, engenharia de passagem, água subterrânea, quedas, edição concorrente, formação coletiva e coleta de excedentes.

O teste de navegador verifica os voxels efetivos do túnel, da ponte e da parede, inventário, conclusão das obras e ausência de erros de página. Testes de regressão das cenas de colapso, cavernas e smoke também foram executados durante a integração.

## Limites explícitos

- Há um perfil de locomoção terrestre fixo. Não há natação, voo, salto sobre vãos ou física de personagem geral. Vadeamento até 0,5 bloco; blocos com queda individual não são admitidos como apoio navegável. Apoios estruturais com verificações pendentes são tratados conservadoramente.
- Os atalhos de região não constituem HPA* global com grafo abstrato de portais e componentes. A* pode atingir `search-limited`; não transforma limite em prova de ausência de rota.
- Reservas do próximo movimento não são WHCA* completo. Planejamento priorizado e desvio não garantem solução para toda configuração de gargalo ou troca de destinos.
- Engenharia automática é planar, no nível Y do destino, com raio 8, até 8 alterações e 2.048 estados. Não planeja andaimes arbitrários, dependências globais de uma construção, estoques externos ou transporte econômico.
- Prioridade vale entre tarefas da fronteira ativa; não há índice espacial geral nem envelhecimento global de ordens. Designs grandes podem precisar de acesso/andaimes designados explicitamente.
- Validação de perigos móveis usa ocupação conservadora em voxels. Não é certificação antecipada da estabilidade de toda obra nem resistência material; continua valendo o modelo estrutural opt-in existente.
- O benchmark usa piso plano e destinos coletivos. Cavernas extensas, alterações contínuas, gargalos densos, muito excedente e renderização de 1.000 unidades precisam de perfis próprios antes de extrapolar desempenho.
