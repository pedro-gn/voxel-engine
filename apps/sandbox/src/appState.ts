import type { Engine } from '@elovox/engine'
import type { CrowdState } from './crowdScript.ts'
import type { LivingState } from './livingScript.ts'

type V3 = [number, number, number]
export interface CameraState {
  mode: 'orbit' | 'firstPerson'
  orbit: { target: V3; distance: number; pitch: number; yaw: number }
  fp: { position: V3; yaw: number; pitch: number }
}
/** The sandbox's `app` section of a save: the scene, the camera and the scene scripts' state. */
export interface AppState { scene: string; camera: CameraState; scripts: { living?: LivingState; crowd?: CrowdState } }

export function isAppState(v: unknown): v is AppState {
  if (typeof v !== 'object' || v === null) return false
  const a = v as AppState
  return typeof a.scene === 'string' && typeof a.camera === 'object' && a.camera !== null && typeof a.scripts === 'object' && a.scripts !== null
}

export function captureCamera(engine: Engine): CameraState {
  const g = engine.controls.goal, fp = engine.firstPerson
  return {
    mode: engine.cameraMode,
    orbit: { target: [g.target[0], g.target[1], g.target[2]], distance: g.distance, pitch: g.pitch, yaw: g.yaw },
    fp: { position: [fp.position[0], fp.position[1], fp.position[2]], yaw: fp.yaw, pitch: fp.pitch },
  }
}

/** `enterFirstPerson`: the sandbox's own toggle, so its crosshair and pointer lock follow (default: the engine's switch). */
export function applyCamera(engine: Engine, c: CameraState, enterFirstPerson = () => engine.setCameraMode('firstPerson')): void {
  for (const s of [engine.controls.goal, engine.controls.current]) {
    s.target[0] = c.orbit.target[0]; s.target[1] = c.orbit.target[1]; s.target[2] = c.orbit.target[2]
    s.distance = c.orbit.distance; s.pitch = c.orbit.pitch; s.yaw = c.orbit.yaw
  }
  engine.controls.apply(engine.camera)
  if (c.mode !== 'firstPerson') return
  enterFirstPerson()
  // The switch puts the player at the orbit target; the saved spot wins.
  const fp = engine.firstPerson
  fp.position[0] = c.fp.position[0]; fp.position[1] = c.fp.position[1]; fp.position[2] = c.fp.position[2]
  fp.yaw = c.fp.yaw; fp.pitch = c.fp.pitch
}
