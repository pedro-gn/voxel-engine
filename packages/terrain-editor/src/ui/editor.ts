import type { Engine } from '@elovox/engine'
import { BIOME_CELL, TerrainDocError, builtinOps, validateTerrainDoc, type OpDef, type OpRegistry, type ShapeKind, type TerrainDoc, type Vec2 } from '@elovox/terrain'
import { Vector3 } from 'three/webgpu'
import { parseTerrainText, serializeTerrain } from '../core/docio.ts'
import type { Point3 } from '../core/brush.ts'
import { BrushCursor } from './brushes/cursor.ts'
import { LayerOverlay } from './brushes/layerOverlay.ts'
import { BrushController, type BrushMode, type EditorMode } from '../core/brushes.ts'
import { addOp, removeOp, removeVertex, reorderOp, replaceOp, setEnabled, type Edit } from '../core/edits.ts'
import { newOp, nextOpId } from '../core/newOp.ts'
import { PreviewScheduler } from '../core/preview.ts'
import { TerrainSampler } from '../core/sampler.ts'
import { EditorSession, type EditResult } from '../core/session.ts'
import { TerrainFiles, browserFallback, type FileHandle, type FileHost } from './files.ts'
import { dragHandle, translateShape, type DragPoint, type Handle, type HandleKind } from './handles/geometry.ts'
import { LIFT, Overlay, groundSampler } from './handles/overlay.ts'
import { distanceToPolyline, hitHorizontal, hitVertical, nearest, rayAt, toScreen, type ScreenPoint } from './handles/pick.ts'
import { actionFor, isTyping } from './keys.ts'
import { h } from './panels/dom.ts'
import { docFields, opFields } from './panels/fields.ts'
import { createBrushPanel } from './panels/brushPanel.ts'
import { createInspector } from './panels/inspector.ts'
import { createModeTabs } from './panels/modes.ts'
import { createOpList } from './panels/opList.ts'
import { createToolbar } from './panels/toolbar.ts'

export interface TerrainEditorOptions {
  /** The document the engine was created with (raw JSON or a validated document). */
  doc: unknown
  /** The engine's seed: the brushes recompute base heights with it. */
  seed: number
  /** The name "Save" suggests when the document did not come from a file. */
  fileName: string
  ops?: OpRegistry
  /** Where the panels go. Default document.body. */
  root?: HTMLElement
}

export interface TerrainEditor {
  readonly session: EditorSession
  readonly preview: PreviewScheduler
  readonly brushes: BrushController
  /** Client coordinates of a handle of the selected op; null if there is none or it is off screen. */
  handleScreen(kind: HandleKind, index?: number): { x: number; y: number } | null
  dispose(): void
}

/** Pixels within which a pointer grabs a handle, and an outline. */
const HANDLE_PX = 10
const OUTLINE_PX = 6
/** A click that moves less than this clears the selection. */
const CLICK_PX = 4
/** Blocks a duplicate is moved along +x. */
const DUPLICATE_OFFSET = 16
const MESH_SETTLE_TIMEOUT_MS = 10_000

interface Drag {
  handle: Handle | 'body'
  start: OpDef
  grab: DragPoint
  mode: 'xz' | 'y'
  /** Height of the horizontal drag plane. */
  planeY: number
  /** Horizontal normal of the vertical (height) drag plane: the camera's forward direction at the start. */
  normal: { x: number; z: number }
  /** Where the dragged handle stands (x, z). */
  anchor: { x: number; z: number }
  pointerId: number
}

/** Resolves once the mesh queue drained (the regenerated chunks are visible), or after a timeout, with the frames it took. */
function waitForMeshes(engine: Engine): Promise<{ frames: number }> {
  const start = performance.now()
  let frames = 0
  return new Promise((resolve) => {
    const check = () => {
      const s = engine.stats()
      if (s.meshQueue + s.meshInFlight === 0 || performance.now() - start > MESH_SETTLE_TIMEOUT_MS) resolve({ frames })
      else { frames++; requestAnimationFrame(check) }
    }
    check()
  })
}

/** Block ids the outline draping looks through: tree trunks and leaves. */
function treeIds(engine: Engine, doc: TerrainDoc): Set<number> {
  const out = new Set<number>()
  for (const name of [doc.blocks.log, doc.blocks.leaves, doc.blocks.pineLeaves]) {
    try { out.add(engine.blocks.id(name)) } catch { /* not registered: nothing to skip */ }
  }
  return out
}

export function createTerrainEditor(engine: Engine, o: TerrainEditorOptions): TerrainEditor {
  const registry = o.ops ?? builtinOps
  const height = engine.layout.size[1]
  const size: Vec2 = [engine.layout.size[0], engine.layout.size[2]]
  const parsed = validateTerrainDoc(o.doc, { ops: registry, worldHeight: height })
  if (!parsed.ok) throw new TerrainDocError(parsed.errors)
  const camera = engine.camera
  const canvas = engine.renderer.domElement
  const root = o.root ?? document.body

  const session = new EditorSession(parsed.doc, { worldHeight: height, ops: registry })
  const brushes = new BrushController(session, new TerrainSampler({ seed: o.seed, height, ops: registry }))
  let failedId: string | null = null
  const preview = new PreviewScheduler(engine.terrain, parsed.doc, {
    size,
    settle: () => waitForMeshes(engine),
    onStatus: (s) => {
      failedId = s.state === 'error' ? s.opId : s.state === 'idle' ? null : failedId
      renderToolbar()
      renderList()
      invalidate()
    },
  })
  const files = new TerrainFiles(window as unknown as FileHost, browserFallback(document))
  let fileHandle: FileHandle | null = null
  let fileName = o.fileName
  let showAll = false
  let showLayers = false

  const skip = treeIds(engine, parsed.doc)
  const ground = groundSampler(engine.world.get, skip, height, size)
  const overlay = new Overlay(ground)
  engine.scene.add(overlay.group)
  const cursor = new BrushCursor(ground)
  engine.scene.add(cursor.group)
  /** The last aim point under the pointer, and whether it was the Shift-locked one. */
  let lastAim: { aim: Point3; locked: boolean } | null = null

  function drawCursor(): void {
    const c = brushes.current
    if (!c || !lastAim) { cursor.hide(); return }
    const { aim, locked } = lastAim
    const r = c.settings.radius
    if (brushes.mode === 'density') cursor.sphere(aim.x, aim.y, aim.z, r, locked)
    else if (brushes.mode === 'biome') cursor.cells(aim.x, aim.z, r, BIOME_CELL)
    else cursor.circle(aim.x, aim.z, r, c.settings.falloff > 0 ? r * (1 - c.settings.falloff) : null)
  }

  const layerOverlay = new LayerOverlay(ground)
  engine.scene.add(layerOverlay.group)
  let layersDirty = true
  const invalidateLayers = () => { layersDirty = true }
  const flushLayers = () => {
    if (!layersDirty) return
    layersDirty = false
    const mode = brushes.mode === 'height' || brushes.mode === 'biome' ? brushes.mode : null
    layerOverlay.draw(session.doc.layers, showLayers ? mode : null)
  }

  // ---- panels
  const left = h('div', { style: { position: 'fixed', top: '12px', left: '12px', width: '300px', display: 'grid', gap: '8px', zIndex: '6', maxHeight: 'calc(100vh - 24px)', alignContent: 'start' } })
  const right = h('div', { style: { position: 'fixed', top: '52px', right: '12px', width: '310px', zIndex: '6' } })
  root.append(left, right)

  const report = (r: EditResult): boolean => {
    inspector.setErrors(r.ok ? [] : r.errors)
    return r.ok
  }
  const run = (label: string, edit: Edit): boolean => {
    finishGesture()
    return report(session.apply(label, edit))
  }
  const selectedDef = (): OpDef | null => session.doc.ops.find((op) => op.id === session.selected) ?? null

  const toolbar = createToolbar(left, {
    open: () => void open(),
    save: () => void save(false),
    saveAs: () => void save(true),
    undo: () => { endDrag(); session.undo() },
    redo: () => { endDrag(); session.redo() },
    showAll: (on) => { showAll = on; invalidate(); renderToolbar() },
    showLayers: (on) => { showLayers = on; invalidateLayers(); renderToolbar() },
  })
  const list = createOpList(left, registry, {
    select: (id) => session.select(id),
    toggle: (id, on) => run(on ? 'enable' : 'disable', setEnabled(id, on)),
    move: (id, delta) => run('reorder', reorderOp(id, delta)),
    add,
  })
  const inspector = createInspector(right, {
    run,
    live: (label, edit) => {
      if (!session.inGesture) session.begin(label)
      report(session.update(edit))
    },
    endLive: () => { if (session.inGesture) session.commit() },
  })
  const tabs = createModeTabs(toolbar.el, setMode)
  const brushPanel = createBrushPanel(right, {
    tool: (t) => brushes.setTool(t),
    settings: (s) => brushes.setSettings(s),
    biome: (k) => brushes.setBiome(k),
  })

  function renderBrushes(): void {
    tabs.render(brushes.mode)
    const c = brushes.current
    inspector.el.style.display = c ? 'none' : 'grid' // both panels lay out as grids (PANEL_STYLE)
    brushPanel.el.style.display = c ? 'grid' : 'none'
    if (c) brushPanel.render({ mode: brushes.mode as BrushMode, tool: c.tool, settings: c.settings, biomes: session.doc.biomes.map((b) => b.name), biome: brushes.biome })
  }

  function renderToolbar(): void {
    toolbar.render({ fileName, dirty: session.dirty, canUndo: session.canUndo, canRedo: session.canRedo, status: preview.status, showAll, showLayers })
  }
  function renderList(): void {
    list.render(session.doc, session.selected, failedId)
  }
  function renderInspector(): void {
    const def = selectedDef()
    if (!def) {
      inspector.render('document', docFields(session.doc, height), '')
      return
    }
    const index = session.doc.ops.indexOf(def)
    inspector.render(`${def.id} · ${def.type}`, opFields(def, registry.get(def.type)!, session.doc, height), `ops[${index}].`)
  }

  // ---- overlay, redrawn at most once per frame
  let overlayDirty = true
  const invalidate = () => { overlayDirty = true }
  const flushOverlay = () => {
    if (!overlayDirty) return
    overlayDirty = false
    const ops = brushes.mode === 'ops' ? session.doc.ops : [] // brushes hide the op outlines and handles
    overlay.draw(ops.map((def) => ({ def, impl: registry.get(def.type)!, selected: def.id === session.selected, failed: def.id === failedId })), showAll && brushes.mode === 'ops')
  }
  let raf = 0
  const frame = () => {
    flushOverlay()
    flushLayers()
    overlay.scaleMarkers(camera, canvas.clientHeight)
    raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)

  const offChange = session.on('change', (e) => {
    preview.onChange(e)
    renderToolbar(); renderList(); renderInspector(); invalidate(); invalidateLayers(); renderBrushes()
  })
  const offSelect = session.on('select', () => {
    inspector.setErrors([])
    renderList(); renderInspector(); invalidate()
  })
  const offGenerated = engine.on('generated', invalidate) // the ground under the outlines changed
  const offCursorGenerated = engine.on('generated', drawCursor) // the ground under the cursor moved
  const offLayersGenerated = engine.on('generated', invalidateLayers)
  const offBrushes = brushes.onChange(() => { invalidate(); invalidateLayers(); renderBrushes(); drawCursor() })

  function setMode(m: EditorMode): void {
    if (brushes.stroking) return
    finishGesture()
    brushes.setMode(m)
  }

  // ---- pointer
  const viewport = () => ({ width: canvas.clientWidth, height: canvas.clientHeight })
  const local = (e: { clientX: number; clientY: number }): ScreenPoint => {
    const r = canvas.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const screenOf = (p: Vector3) => toScreen(p, camera, viewport())
  let drag: Drag | null = null
  let click: ScreenPoint | null = null
  let brushPointer: number | null = null
  /** Camera distance of the stroke's first aim point: Shift keeps the density sphere there. */
  let lockDistance: number | null = null

  /**
   * Where the brush aims: just above the voxel under the pointer (height, biome), that voxel's centre
   * (density), or with `lock` during a density stroke the point at the stroke's first distance along the ray.
   */
  function aimPoint(e: { clientX: number; clientY: number }, lock: boolean): Point3 | null {
    if (brushes.mode === 'density' && lock && lockDistance !== null) {
      const ray = rayAt(camera, viewport(), local(e))
      return { x: ray.origin.x + ray.dir.x * lockDistance, y: ray.origin.y + ray.dir.y * lockDistance, z: ray.origin.z + ray.dir.z * lockDistance }
    }
    const hit = engine.pickScreen(e.clientX, e.clientY)
    if (!hit) return null
    const [x, y, z] = hit.pos
    return brushes.mode === 'density' ? { x: x + 0.5, y: y + 0.5, z: z + 0.5 } : { x: x + 0.5, y: y + 1, z: z + 0.5 }
  }

  function releaseBrush(): void {
    if (brushPointer !== null && canvas.hasPointerCapture(brushPointer)) canvas.releasePointerCapture(brushPointer)
    brushPointer = null
    lockDistance = null
  }

  function startDrag(e: PointerEvent, def: OpDef, handle: Handle | 'body', pos: Vector3, mode: 'xz' | 'y', at: ScreenPoint): void {
    const forward = new Vector3()
    camera.getWorldDirection(forward)
    const grab: DragPoint = mode === 'y'
      ? { x: pos.x, z: pos.z, y: pos.y - LIFT }
      : hitHorizontal(rayAt(camera, viewport(), at), pos.y) ?? { x: pos.x, z: pos.z }
    session.begin(handle === 'body' ? `move ${def.id}` : `${handle.kind} ${def.id}`)
    drag = { handle, start: def, grab, mode, planeY: pos.y, normal: { x: forward.x, z: forward.z }, anchor: { x: pos.x, z: pos.z }, pointerId: e.pointerId }
    canvas.setPointerCapture(e.pointerId)
    e.preventDefault()
  }

  function endDrag(): void {
    if (!drag) return
    if (canvas.hasPointerCapture(drag.pointerId)) canvas.releasePointerCapture(drag.pointerId)
    drag = null
  }

  /** Ends a drag (if any) and commits whatever gesture is open. */
  function finishGesture(): void {
    endDrag()
    if (session.inGesture) session.commit()
  }

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || drag) return
    // let a pending field change land (the blur fires its change) and settle any open gesture, before reading the document
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    finishGesture()
    flushOverlay()
    if (brushes.mode !== 'ops') {
      const aim = aimPoint(e, false)
      if (!aim) return
      lockDistance = new Vector3().setFromMatrixPosition(camera.matrixWorld).distanceTo(new Vector3(aim.x, aim.y, aim.z))
      brushes.begin(aim, e.ctrlKey)
      brushPointer = e.pointerId
      canvas.setPointerCapture(e.pointerId)
      e.preventDefault()
      return
    }
    const at = local(e)
    const def = selectedDef()
    if (def) {
      const hit = nearest(overlay.handles, (p) => screenOf(p.pos), at, HANDLE_PX)
      if (hit) {
        if (e.altKey) {
          if (hit.handle.kind === 'vertex') run('remove vertex', removeVertex(def.id, hit.handle.index))
          return
        }
        startDrag(e, def, hit.handle, hit.pos, e.shiftKey && hit.handle.y !== undefined ? 'y' : 'xz', at)
        return
      }
      let best: { d: number; pos: Vector3 } | null = null
      for (const line of overlay.outlines) {
        if (line.id !== def.id) continue
        const pts = line.points.map(screenOf)
        if (distanceToPolyline(at, pts, line.closed) > OUTLINE_PX) continue
        const near = nearest(line.points, screenOf, at, Infinity)
        if (near) { const s = screenOf(near)!; const d = Math.hypot(s.x - at.x, s.y - at.y); if (!best || d < best.d) best = { d, pos: near } }
      }
      if (best) { startDrag(e, def, 'body', best.pos, 'xz', at); return }
    }
    if (showAll) {
      let pick: { id: string; d: number } | null = null
      for (const line of overlay.outlines) {
        const d = distanceToPolyline(at, line.points.map(screenOf), line.closed)
        if (d <= OUTLINE_PX && (!pick || d < pick.d)) pick = { id: line.id, d }
      }
      if (pick) { session.select(pick.id); return }
    }
    click = at
  }

  const onMove = (e: PointerEvent) => {
    if (brushes.mode !== 'ops') {
      const locked = brushPointer === e.pointerId && e.shiftKey && brushes.mode === 'density'
      const aim = aimPoint(e, locked)
      lastAim = aim ? { aim, locked } : null
      drawCursor()
      if (brushPointer === e.pointerId && aim) brushes.move(aim, e.ctrlKey)
      return
    }
    if (!drag || e.pointerId !== drag.pointerId) return
    const ray = rayAt(camera, viewport(), local(e))
    let to: DragPoint | null
    if (drag.mode === 'y') {
      const y = hitVertical(ray, drag.anchor, drag.normal)
      to = y === null ? null : { x: drag.anchor.x, z: drag.anchor.z, y: y - LIFT }
    } else {
      to = hitHorizontal(ray, drag.planeY)
    }
    if (!to) return // the ray missed the drag plane: keep the last position
    const next = dragHandle(drag.start, registry.get(drag.start.type)!, drag.handle, drag.grab, to)
    report(session.update(replaceOp(drag.start.id, next)))
  }

  const onUp = (e: PointerEvent) => {
    if (brushPointer === e.pointerId) {
      releaseBrush()
      brushes.end()
      return
    }
    if (drag && e.pointerId === drag.pointerId) {
      finishGesture()
      return
    }
    if (e.button === 0 && click) {
      const at = local(e)
      if (Math.hypot(at.x - click.x, at.y - click.y) < CLICK_PX) session.select(null)
      click = null
    }
  }

  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerup', onUp)
  const onLost = (e: PointerEvent) => {
    if (brushPointer === e.pointerId) { brushPointer = null; lockDistance = null; brushes.end() }
    if (drag && e.pointerId === drag.pointerId) finishGesture()
  }
  canvas.addEventListener('lostpointercapture', onLost)
  const onLeave = () => { if (brushPointer === null) { lastAim = null; cursor.hide() } } // the pointer went over a panel or off the canvas
  canvas.addEventListener('pointerleave', onLeave)

  // ---- keyboard
  const onKey = (e: KeyboardEvent) => {
    const action = actionFor(e, isTyping(document.activeElement))
    if (!action) return
    switch (action) {
      case 'save': e.preventDefault(); void save(false); break
      case 'cancel': {
        const busy = brushes.stroking || session.inGesture || drag !== null
        endDrag(); releaseBrush(); brushes.cancel(); session.cancel()
        if (!busy) setMode('ops') // Esc outside a stroke leaves the brushes
        break
      }
      case 'undo':
        e.preventDefault(); endDrag()
        if (brushes.stroking) { releaseBrush(); brushes.cancel() } else session.undo()
        break
      case 'redo':
        e.preventDefault(); endDrag()
        if (brushes.stroking) { releaseBrush(); brushes.cancel() } else session.redo()
        break
      case 'mode-ops': setMode('ops'); break
      case 'mode-height': setMode('height'); break
      case 'mode-biome': setMode('biome'); break
      case 'mode-density': setMode('density'); break
      case 'radius-down': case 'radius-up': {
        const c = brushes.current
        if (c) brushes.setSettings({ radius: c.settings.radius * (action === 'radius-up' ? 1.25 : 0.8) })
        break
      }
      case 'delete': if (session.selected) run(`delete ${session.selected}`, removeOp(session.selected)); break
      case 'duplicate': e.preventDefault(); duplicate(); break
      case 'toggle': { const d = selectedDef(); if (d) run(d.enabled ? 'disable' : 'enable', setEnabled(d.id, !d.enabled)); break }
    }
  }
  window.addEventListener('keydown', onKey)
  const onUnload = (e: BeforeUnloadEvent) => {
    if (!session.dirty) return
    e.preventDefault()
    e.returnValue = ''
  }
  window.addEventListener('beforeunload', onUnload)

  // ---- commands
  function add(type: string, kind: ShapeKind): void {
    const impl = registry.get(type)
    if (!impl) return
    const r = canvas.getBoundingClientRect()
    const hit = engine.pickScreen(r.left + r.width / 2, r.top + r.height / 2)
    const t = engine.controls.current.target
    const at: Vec2 = hit ? [hit.pos[0], hit.pos[2]] : [t[0], t[2]]
    const op = newOp(impl, kind, session.doc, { at, ground: ground(at[0], at[1]), height })
    if (run(`add ${op.id}`, addOp(op))) session.select(op.id)
  }

  function duplicate(): void {
    const def = selectedDef()
    if (!def) return
    const copy: OpDef = { ...def, id: nextOpId(session.doc, def.type), shape: translateShape(def.shape, DUPLICATE_OFFSET, 0) }
    if (run(`duplicate ${def.id}`, addOp(copy, session.doc.ops.indexOf(def) + 1))) session.select(copy.id)
  }

  async function open(): Promise<void> {
    if (session.dirty && !window.confirm('Discard the unsaved changes?')) return
    try {
      const f = await files.open()
      if (!f) return
      const r = parseTerrainText(f.text, { size, worldHeight: height, ops: registry })
      if (!r.ok) { inspector.setErrors(r.errors.map((err) => `${f.name}: ${err}`)); return }
      endDrag()
      session.open(r.doc)
      skip.clear()
      for (const id of treeIds(engine, r.doc)) skip.add(id)
      fileHandle = f.handle
      fileName = f.name
      renderToolbar()
    } catch (err) {
      inspector.setErrors([`open failed: ${err instanceof Error ? err.message : String(err)}`])
    }
  }

  async function save(as: boolean): Promise<void> {
    finishGesture()
    try {
      const doc = session.doc
      const r = await files.save(serializeTerrain(doc), as ? null : fileHandle, fileName)
      if (!r) return
      fileHandle = r.handle
      fileName = r.name
      session.markSaved(doc)
      renderToolbar()
    } catch (err) {
      inspector.setErrors([`save failed: ${err instanceof Error ? err.message : String(err)}`])
    }
  }

  renderToolbar(); renderList(); renderInspector(); renderBrushes()

  return {
    session,
    preview,
    brushes,
    handleScreen(kind, index = 0) {
      flushOverlay()
      const p = overlay.handles.find((x) => x.handle.kind === kind && x.handle.index === index)
      const s = p ? screenOf(p.pos) : null
      if (!s) return null
      const r = canvas.getBoundingClientRect()
      return { x: r.left + s.x, y: r.top + s.y }
    },
    dispose() {
      cancelAnimationFrame(raf)
      endDrag()
      releaseBrush(); brushes.cancel()
      if (session.inGesture) session.cancel()
      offChange(); offSelect(); offGenerated(); offCursorGenerated(); offLayersGenerated()
      offBrushes()
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('lostpointercapture', onLost)
      canvas.removeEventListener('pointerleave', onLeave)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('beforeunload', onUnload)
      overlay.dispose()
      cursor.dispose()
      layerOverlay.dispose()
      left.remove()
      right.remove()
    },
  }
}
