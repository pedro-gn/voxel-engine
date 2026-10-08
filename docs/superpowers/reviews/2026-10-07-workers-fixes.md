# Consertos da revisão de navegação e unidades

Data: 2026-10-07. Base: [sete problemas confirmados pelos revisores](2026-10-07-workers-agent-review.md).

O usuário solicitou subagentes GPT-6.1 Sol com raciocínio alto. Um novo subagente com essa configuração executou os grupos de correção sequencialmente: o ambiente recusou a criação dos demais por limite de threads. A raiz revisou a integração, reproduziu casos de atribuição/escala e executou a validação conjunta. Nenhum commit foi criado.

## Resultado por problema

| Problema | Correção | Regressão |
|---|---|---|
| Cliques após giro da câmera | A view mede cada gesto por pointerId, sem herdar a distância do arrasto anterior | Seleção, escavação e construção após arrasto; o gesto que arrasta continua recusado |
| Picking de proxies | Exclui mesh vazio do raycast e invalida boundingSphere quando count/matrizes mudam | Unidade nº 25 após picking com proxies vazios e após mover além da esfera anterior |
| Oito tarefas inviáveis monopolizam a shortlist | Verifica material/ferramenta antes das oito tentativas de posição de trabalho | Nona tarefa executável conclui para ambos os tipos de falta de recurso |
| Falta de acesso bloqueia outros executores | Falhas decisórias por unidade e origem; revisões de acessibilidade/tráfego, limpeza no despawn | Nova unidade junto ao alvo trabalha com a primeira ativa ou parada |
| Subida sem apoio | Revalida apoio inicial no início da transição e durante a fase vertical da subida | Perda de apoio em subida/descida; perda após iniciar a elevação; subida normal preservada |
| Limite vira ausência de caminho | Marca corte espacial apenas de expansão viável e conserva o limite do A* anterior | Desvio fora do raio; fallback confinado que é unreachable após A* limited |
| Hash omite estado futuro | Inclui motivos, falhas por unidade, alternativas, tarefas sintéticas, obstáculos temporários e delimitadores | Sensibilidade a esses campos; replay idêntico continua produzindo hashes iguais |

Mudanças principais: `workersView.ts`, `sim/workers/workers.ts`, `sim/navigation/navigation.ts` e `engineering.ts`. Testes em `workersView.test.ts`, `workers.test.ts`, `navigation.test.ts` e `e2e/workers.spec.ts`.

O E2E agora mantém um mapa dos deltas de estoque, solicita detalhes iniciais sem adicionar itens e compara o total de tábuas: túnel preserva estoque, ponte consome cinco e parede mais dez. O segundo cenário gira a câmera, seleciona uma unidade, designa manualmente, cancela e pausa/retoma.

## Ajustes encontrados durante a integração

**Memória da atribuição:** não guardar falhas de material/ferramenta por par unidade/tarefa. Essas pré-condições já são verificadas em cada tentativa, e tais registros nunca evitavam uma nova tentativa. O diagnóstico continua disponível; cache decisório de acesso/tráfego permanece. Regressões de 64 unidades × 16 tarefas confirmam zero registros para esses motivos e progresso após reabastecimento/chegada de executor capaz.

Ensaio adicional da raiz: mundo 128 × 32 × 128, piso até Y=3, 1.000 unidades sem estoque, uma designação de 256 blocos em `[80,4,80]`..`[95,4,95]`, 64 ticks, Node com `--expose-gc`. Na versão intermediária da correção eram 256.000 registros e 20,92 MiB de crescimento de heap pós-GC; na versão final são zero registros e 0,26 MiB. É uma medição deste cenário, não uma garantia para todos os objetos da simulação.

**Reservas de construção:** criar, cancelar ou concluir uma reserva altera quais poses são permitidas mesmo sem mudar a geometria. Essas mudanças avançam a revisão de acessibilidade e cancelam consultas dependentes, inclusive resultados ainda aguardando consumo pela unidade. Os tiles de geometria são preservados. Testes confirmam que cancelar quatro reservas em torno de um alvo libera a escavação e que a invalidação de política retém o cache de navegação.

O caso existente de mudança do alvo para outro material continua funcionando: a falha do executor é removida quando o valor esperado muda, permitindo reatribuição.

## Validação final

| Verificação | Resultado final |
|---|---|
| Typecheck | Quatro workspaces aprovados |
| Build de produção | Aprovado |
| Suíte completa | 121 arquivos aprovados; 1.167 testes passaram e 2 falhas esperadas existentes |
| Navegação/unidades | 52 testes passaram, incluídos na suíte completa |
| View | 2 testes passaram, incluídos na suíte completa |
| E2E Edge no build final | 13 testes passaram (workers, collapse, caves, smoke), em 1,4 minuto |
| Whitespace | `git diff --check` sem erros |

Foram adicionadas 21 regressões de Vitest nesta rodada em relação à entrega inicial, além do segundo cenário E2E. As regressões principais foram verificadas em vermelho antes das correções. Os dois casos esperados de falha anteriores continuam classificados como esperados.

Comandos da rodada:

```powershell
npm run typecheck
npm run build -w @elovox/sandbox
npm run test --workspaces --if-present -- --testTimeout=30000 --maxWorkers=4
# E2E_CHANNEL=msedge, E2E_PORT=5193, E2E_PREVIEW=1
npm run e2e -w @elovox/sandbox -- workers.spec.ts collapse.spec.ts caves.spec.ts smoke.spec.ts
git diff --check
```

TEMP/TMP apontaram para `node_modules/.cache/navigation-test-tmp` para respeitar as permissões locais. O timeout maior foi opção de CLI; as configurações dos testes existentes não foram alteradas. O build continua emitindo o aviso existente de bundle maior que 500 kB.

## Desempenho após os consertos

[JSON completo](../research/2026-10-07-workers-fixes-results.json), produzido por `node --experimental-strip-types packages/engine/bench/workers.node.ts`, sem testes/build concorrentes. Mesmo protocolo inicial: Node v24.5.0, Ryzen 5 5600, mundo 256 × 128 × 256, orçamento 4.096, ticks completos de Simulation, sem GPU/transporte.

| Unidades | Ocioso p95 (ms) | Movimento p50 (ms) | p95 (ms) | p99 (ms) | Máximo (ms) | Iniciaram em 240 ticks |
|---:|---:|---:|---:|---:|---:|---:|
| 0, desabilitado | 0,017 | — | — | — | — | — |
| 1 | 0,030 | 0,033 | 0,105 | 0,332 | 4,228 | 1 |
| 100 | 0,065 | 0,260 | 1,735 | 2,864 | 5,519 | 100 |
| 1.000 | 0,204 | 1,623 | 3,037 | 4,430 | 9,354 | 610 |

O início das unidades e os tamanhos de arrays/poses permaneceram iguais à medição anterior: para 1.000 unidades, 7.362.560 bytes em arrays de navegação e 36.000 bytes/publicação de poses. Não foi observada regressão nesse ensaio; diferenças de tempo entre execuções não demonstram ganho causal. A amostra termina com 106 andando e 894 planejando e não mede chegada de todas nem FPS com mil modelos. Heap de caches JavaScript não entra no contador de arrays de navegação.

## Limites que permanecem

Os consertos preservam o escopo de locomoção, engenharia local e orçamento descritos no [relatório inicial](2026-10-07-workers-validation.md). HPA* global, WHCA*, planejamento de andaimes, rotação da fronteira de 256 tarefas bloqueadas e sincronização visual por unidade continuam como extensões/melhorias separadas. O evento de frame e as barreiras globais de malha não foram redesenhados nesta rodada.
