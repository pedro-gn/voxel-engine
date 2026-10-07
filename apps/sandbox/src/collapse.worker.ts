import { runSimWorker } from '@elovox/engine/sim-worker'
import { collapseGenerator } from './scenes/collapse.ts'
runSimWorker({ generator: collapseGenerator })
