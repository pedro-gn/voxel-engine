import { runSimWorker } from '@elovox/engine/sim-worker'
import { shapesGenerator } from './scenes/shapes.ts'

runSimWorker({ generator: shapesGenerator })
