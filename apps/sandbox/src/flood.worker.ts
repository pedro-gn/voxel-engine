import { runSimWorker } from '@elovox/engine/sim-worker'
import rules from './rules.ts'
import { floodGenerator } from './scenes/flood.ts'

runSimWorker({ rules, generator: floodGenerator })
