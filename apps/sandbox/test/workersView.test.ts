import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BoxGeometry, Group, InstancedMesh, Mesh, MeshStandardMaterial, PerspectiveCamera } from 'three/webgpu'
import { WORKER_STATES, type Engine, type WorkerTick, type WorkerView } from '@elovox/engine'
import { Layout } from '@elovox/engine/src/world/layout.ts'
import { createWorkersView } from '../src/workersView.ts'

vi.mock('three/addons/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    async loadAsync() {
      const scene = new Group(), body = new Mesh(new BoxGeometry(.65, 1.65, .65), new MeshStandardMaterial())
      body.position.y = .825; scene.add(body)
      return { scene, animations: [] }
    }
  },
}))

// Only the panel DOM is stubbed. Poses, instance bounds and picking use real Three objects.
class Element extends EventTarget {
  readonly tag: string
  constructor(tag = '') { super(); this.tag = tag }
  textContent = ''; className = ''; type = ''; value = ''; checked = false
  children: Element[] = []
  private selectors = new Map<string, Element>()
  set innerHTML(_: string) {
    for (const selector of ['.workers-tools', '.workers-actions', '.workers-help', '[role=status]', '.workers-status', 'select']) this.selectors.set(selector, new Element())
  }
  append(...elements: Element[]) { this.children.push(...elements); if (this.tag === 'select' && !this.value) this.value = elements[0]?.value ?? '' }
  insertBefore(element: Element) { this.append(element) }
  querySelector(selector: string) { return this.selectors.get(selector) ?? null }
  setAttribute() {}
  remove() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 } }
}

function pointer(canvas: Element, type: string, button: number, x = 400, y = 300) {
  canvas.dispatchEvent(Object.assign(new Event(type), { button, pointerId: 1, clientX: x, clientY: y, shiftKey: false }))
}
function unit(id: number, x = 100): WorkerView {
  return { id, available: true, x256: x * 256, y256: 0, z256: 0, facing: 0, state: 'idle', order: 0, progress: 0, duration: 0, stock: [] }
}

describe('workers view input and proxy picking', () => {
  let view: Awaited<ReturnType<typeof createWorkersView>>, canvas: Element, panel: Element, engine: Engine
  let emit: (type: string, value: unknown) => void
  let submit: ReturnType<typeof vi.fn>
  beforeEach(async () => {
    const body = new Element()
    vi.stubGlobal('document', { head: new Element(), body, createElement: (tag: string) => new Element(tag) })
    vi.stubGlobal('window', new EventTarget())
    vi.spyOn(performance, 'now').mockReturnValue(0)
    const listeners = new Map<string, Set<(value: any) => void>>()
    emit = (type, value) => { for (const fn of listeners.get(type) ?? []) fn(value) }
    const camera = new PerspectiveCamera(50, 800 / 600, .1, 1000)
    camera.position.set(0, .825, 10); camera.lookAt(0, .825, 0); camera.updateMatrixWorld()
    submit = vi.fn()
    engine = {
      scene: new Group(), camera, controls: { lastDragDistance: 50 }, submit,
      blocks: { id: () => 1, name: () => 'planks' }, physics: { paused: false }, meshVersion: () => 0, layout: new Layout([128, 32, 128]),
      pickScreen: () => null,
      on(type: string, fn: (value: any) => void) { const set = listeners.get(type) ?? new Set(); set.add(fn); listeners.set(type, set); return () => set.delete(fn) },
    } as unknown as Engine
    canvas = new Element(); view = await createWorkersView(engine, canvas as unknown as HTMLCanvasElement)
    panel = body.children[0]!
    submit.mockClear()
  })
  afterEach(() => { view?.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

  function publish(units: WorkerView[], barriers: { chunk: number; version: number }[] = [], now = 50) {
    const tick = { barriers: barriers.length ? [{ unit: 0, pos: [0, 0, 0], chunks: barriers }] : [], details: units, poses: Int32Array.from(units.flatMap(u => [u.id, u.x256, u.y256, u.z256, u.facing, WORKER_STATES.indexOf(u.state), 0, 0, 0])) } as unknown as WorkerTick
    emit('workers', tick); emit('frame', { dt: .05, now }); engine.scene.updateMatrixWorld(true)
  }
  function click(button = 0) { pointer(canvas, 'pointerdown', button); pointer(canvas, 'pointerup', button) }
  function summary() { return panel.querySelector('.workers-status')!.textContent }
  function tool(label: string) { panel.querySelector('.workers-tools')!.children.find(b => b.textContent === label)!.dispatchEvent(new Event('click')) }

  function skinX(id: number) { return (engine.scene.children[0] as Group).children.find(o => o instanceof Group && o.userData.unit === id)!.position.x }

  it('without the demo it spawns no units and adds no demonstration buttons', async () => {
    submit.mockClear()
    const plain = await createWorkersView(engine, new Element() as unknown as HTMLCanvasElement, { demo: false })
    expect(submit.mock.calls.filter(([c]) => c.type === 'unitSpawn')).toHaveLength(0)
    const actions = (document.body as unknown as Element).children.at(-1)!.querySelector('.workers-actions')!
    expect(actions.children.map(b => b.textContent)).not.toContain('Abrir túnel')
    expect(actions.children.map(b => b.textContent)).toContain('Selecionar todas')
    plain.dispose()
  })
  it('holds only units near a pending mesh barrier and releases a barrier whose mesh never arrives', () => {
    const near = unit(1, 1), far = unit(2, 80)
    publish([near, far])
    const chunk = engine.layout.chunkOf(1, 0, 0)
    publish([{ ...near, x256: 2 * 256 }, { ...far, x256: 81 * 256 }], [{ chunk, version: 5 }], 100)
    expect(skinX(1)).toBe(1); expect(skinX(2)).toBe(81)
    publish([{ ...near, x256: 2 * 256 }, { ...far, x256: 81 * 256 }], [], 2000)
    expect(skinX(1)).toBe(2)
  })
  it('does not select an incapacitated unit through its hidden body', () => {
    engine.controls.lastDragDistance = 0
    publish([{ ...unit(1, 0), state: 'incapacitated' }])
    click()
    expect(summary()).toContain('0 selecionadas')
  })
  it('turns toward the actual diagonal and retains that heading after stopping', () => {
    publish([unit(1, 0)])
    const skin = (engine.scene.children[0] as Group).children.find(o => o instanceof Group)!
    publish([{ ...unit(1, 1), z256: 256, facing: 1, state: 'idle' }])
    expect(skin.rotation.y).toBeGreaterThan(0)
    expect(skin.rotation.y).toBeLessThan(Math.PI / 4)
    for (let i = 0; i < 20; i++) emit('frame', { dt: .05, now: 100 + i * 50 })
    expect(skin.rotation.y).toBeCloseTo(Math.PI / 4, 3)
    Object.assign(engine.physics, { paused: true }); const before = skin.rotation.y
    publish([{ ...unit(1, 2), z256: 0, facing: 3, state: 'walking' }])
    expect(skin.rotation.y).toBe(before)
  })

  it('selects and designates on new left gestures after a camera drag, but rejects the dragged gesture', () => {
    publish([unit(1, 0)])
    pointer(canvas, 'pointerdown', 2); pointer(canvas, 'pointermove', 2, 450); pointer(canvas, 'pointerup', 2, 450)
    click()
    expect(summary()).toContain('1 selecionadas')
    engine.pickScreen = () => ({ pos: [5, 4, 5], normal: [0, 1, 0], distance: 20 } as ReturnType<Engine['pickScreen']>)
    tool('Escavar')
    pointer(canvas, 'pointerdown', 0); pointer(canvas, 'pointermove', 0, 450); pointer(canvas, 'pointerup', 0, 450)
    expect(submit).not.toHaveBeenCalled()
    click()
    expect(submit).toHaveBeenCalledWith({ type: 'workDig', min: [5, 4, 5], max: [5, 4, 5], ids: [1], priority: 128 })
    tool('Construir'); click()
    expect(submit).toHaveBeenLastCalledWith({ type: 'workBuild', min: [5, 5, 5], max: [5, 5, 5], ids: [1], priority: 128, voxel: 1 })
  })

  it('selects a proxy added after picking an empty proxy mesh and again after it moves outside old bounds', () => {
    engine.controls.lastDragDistance = 0
    publish([unit(1)])
    click() // Picking while all units have skins must not cache empty proxy bounds.
    publish([...Array.from({ length: 24 }, (_, i) => unit(i + 1)), unit(25, 0)])
    click()
    expect(summary()).toContain('#25 Livre')
    const proxies = (engine.scene.children[0] as Group).children.find(o => o instanceof InstancedMesh) as InstancedMesh
    proxies.computeBoundingSphere() // Establish a real previous bound before changing the matrix.
    publish([...Array.from({ length: 24 }, (_, i) => unit(i + 1)), unit(25, 20)])
    engine.camera.position.x = 20; engine.camera.lookAt(20, .825, 0); engine.camera.updateMatrixWorld()
    click()
    expect(summary()).toContain('#25 Livre')
    expect(summary()).toContain('1 selecionadas')
  })
})
