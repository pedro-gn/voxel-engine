import { runSimWorker } from '@elovox/engine/sim-worker'
import rules from './rules.ts'
import { cavesGenerator } from './scenes/caves.ts'

runSimWorker({ rules, generator: cavesGenerator })
