import { AnimationMixer, BackSide, Mesh, type AnimationAction, type Object3D } from 'three/webgpu'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import type { Engine } from '@elovox/engine'

export interface Character {
  readonly root: Object3D
  readonly mixer: AnimationMixer
  /** Name of the clip that is playing. */
  readonly clip: string
  play(name: string): void
  dispose(): void
}

const FADE_S = 0.25

/**
 * Loads a glTF character (rig + clips, 1 unit = 1 block, facing +Z), stands it on the ground
 * at (x, z) facing the camera, and plays `idle`. The engine has no per-frame hook, so the mixer
 * runs on its own requestAnimationFrame.
 */
export async function spawnCharacter(engine: Engine, url: string, x: number, z: number): Promise<Character> {
  const gltf = await new GLTFLoader().loadAsync(url)
  const root = gltf.scene
  root.traverse((o) => {
    if (!(o instanceof Mesh)) return
    o.castShadow = true
    o.receiveShadow = true
    // The sun's bias is tuned for flat block faces; a curved closed mesh self-shadows in
    // stripes unless its back faces are what goes into the shadow map.
    for (const m of [o.material].flat()) m.shadowSide = BackSide
  })
  const top = engine.layout.size[1] - 0.5
  const hit = engine.raycast([x, top, z], [0, -1, 0])
  root.position.set(x, hit ? hit.pos[1] + 1 : 0, z)
  const cam = engine.camera.position
  root.rotation.y = Math.atan2(cam.x - x, cam.z - z)
  engine.scene.add(root)

  const mixer = new AnimationMixer(root)
  const actions = new Map<string, AnimationAction>(gltf.animations.map((c) => [c.name, mixer.clipAction(c)]))
  let clip = ''
  const play = (name: string) => {
    const next = actions.get(name)
    if (!next || name === clip) return
    const prev = actions.get(clip)
    next.reset().play()
    if (prev) next.crossFadeFrom(prev, FADE_S, false)
    clip = name
  }
  play('idle')

  let last = performance.now()
  let frame = requestAnimationFrame(function tick(now) {
    mixer.update(Math.min(0.1, (now - last) / 1000))
    last = now
    frame = requestAnimationFrame(tick)
  })
  return {
    root, mixer, play,
    get clip() { return clip },
    dispose() {
      cancelAnimationFrame(frame)
      mixer.stopAllAction()
      engine.scene.remove(root)
    },
  }
}
