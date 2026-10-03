import { runGenWorker } from '@elovox/engine/gen-worker'
import { terrainGenerator } from '@elovox/terrain'

runGenWorker({ generator: terrainGenerator })
