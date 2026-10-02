import { runSimWorker } from '@elovox/engine/sim-worker'
import rules from './rules.ts'
import { dioramaGenerator } from './scenes/diorama.ts'

runSimWorker({ rules, generator: dioramaGenerator })
