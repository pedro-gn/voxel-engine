import { runSimWorker, testGenerator } from '@elovox/engine/sim-worker'
import rules from './rules.ts'

runSimWorker({ rules, generator: testGenerator })
