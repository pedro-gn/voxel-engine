import { runSimWorker } from '@elovox/engine/sim-worker'
import { workersGenerator } from './scenes/workers.ts'
runSimWorker({ generator: workersGenerator })
