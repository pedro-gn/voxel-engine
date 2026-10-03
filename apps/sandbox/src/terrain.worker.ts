import { runSimWorker } from '@elovox/engine/sim-worker'
import { terrainGenerator } from '@elovox/terrain'
import rules from './rules.ts'

runSimWorker({ rules, generator: terrainGenerator })
