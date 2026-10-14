import { runSimWorker } from '@elovox/engine/sim-worker'
import { createWander, skyGenerator } from './scenes/sky.ts'

runSimWorker({ generator: skyGenerator, systems: [createWander()] })
