import type { TerrainDoc, TerrainLayers } from '@elovox/terrain'
import { biomeDab } from './biomeBrush.ts'
import { DabSpacer, clampSettings, dabSpacing, type BrushSettings, type Point3 } from './brush.ts'
import { densityDab, type DensityTool } from './densityBrush.ts'
import { heightAt, heightDab, type HeightTool } from './heightBrush.ts'
import type { TerrainSampler } from './sampler.ts'
import type { EditorSession } from './session.ts'

export type EditorMode = 'ops' | 'height' | 'biome' | 'density'
export type BrushMode = Exclude<EditorMode, 'ops'>
export type BiomeTool = 'paint' | 'erase'
export const EDITOR_MODES: readonly EditorMode[] = ['ops', 'height', 'biome', 'density']
export const BRUSH_TOOLS: { readonly height: readonly HeightTool[]; readonly biome: readonly BiomeTool[]; readonly density: readonly DensityTool[] } = {
  height: ['raise', 'smooth', 'flatten'],
  biome: ['paint', 'erase'],
  density: ['add', 'smooth'],
}

export interface ToolState<T extends string> { tool: T; settings: BrushSettings }
/** A brush's current tool, and the settings each of its tools remembers (spec section 5: settings are per tool). */
interface Brush<T extends string> { tool: T; settings: Record<T, BrushSettings> }
interface Tools { height: Brush<HeightTool>; biome: Brush<BiomeTool>; density: Brush<DensityTool> }

function defaultTools(): Tools {
  const height: BrushSettings = { radius: 12, strength: 0.5, falloff: 0.6 }
  const biome: BrushSettings = { radius: 12, strength: 1, falloff: 0 }
  const density: BrushSettings = { radius: 6, strength: 0.5, falloff: 0.5 }
  return {
    height: { tool: 'raise', settings: { raise: { ...height }, smooth: { ...height }, flatten: { ...height } } },
    biome: { tool: 'paint', settings: { paint: { ...biome }, erase: { ...biome } } },
    density: { tool: 'add', settings: { add: { ...density }, smooth: { ...density } } },
  }
}

/** The 2D brushes act on columns: their dabs are spaced by distance in x and z only. */
function planar(mode: BrushMode, p: Point3): Point3 {
  return mode === 'density' ? p : { x: p.x, y: 0, z: p.z }
}

/**
 * The brush tools: the mode, each brush's tool and settings, and strokes. A stroke is one session
 * gesture (one undo step); each move places dabs along the way and updates the document once.
 */
export class BrushController {
  private readonly session: EditorSession
  private readonly sampler: TerrainSampler
  private readonly tools: Tools = defaultTools()
  private modeValue: EditorMode = 'ops'
  private biomeValue = 1
  private stroke: { spacer: DabSpacer; target: number } | null = null
  private readonly changeFns = new Set<() => void>()

  constructor(session: EditorSession, sampler: TerrainSampler) {
    this.session = session
    this.sampler = sampler
  }

  get mode(): EditorMode { return this.modeValue }
  get stroking(): boolean { return this.stroke !== null }
  /** The current brush's tool and settings; null in ops mode. */
  get current(): ToolState<string> | null {
    const m = this.modeValue
    return m === 'ops' ? null : this.stateOf(m)
  }
  /** The biome `paint` writes: k paints biomes[k - 1]. */
  get biome(): number { return this.biomeValue }

  /** Called when the mode, a tool, a setting or the biome changes. */
  onChange(fn: () => void): () => void {
    this.changeFns.add(fn)
    return () => { this.changeFns.delete(fn) }
  }

  /** Switches mode; refused (false) during a stroke. */
  setMode(m: EditorMode): boolean {
    if (this.stroke) return false
    if (m !== this.modeValue) { this.modeValue = m; this.emit() }
    return true
  }

  /** Picks a tool of the current brush; unknown tools are ignored. */
  setTool(tool: string): void {
    const m = this.modeValue
    if (m === 'ops' || !(BRUSH_TOOLS[m] as readonly string[]).includes(tool)) return
    ;(this.tools[m] as Brush<string>).tool = tool
    this.emit()
  }

  setSettings(s: Partial<BrushSettings>): void {
    const m = this.modeValue
    if (m === 'ops') return
    const t = this.stateOf(m)
    ;(this.tools[m].settings as Record<string, BrushSettings>)[t.tool] = clampSettings({ ...t.settings, ...s })
    this.emit()
  }

  setBiome(k: number): void {
    this.biomeValue = Math.max(1, Math.min(this.session.doc.biomes.length, Math.round(k)))
    this.emit()
  }

  /** Starts a stroke at `p` (and dabs there). Does nothing in ops mode or while another gesture is open. */
  begin(p: Point3, invert: boolean): void {
    const mode = this.modeValue
    if (mode === 'ops' || this.stroke || this.session.inGesture) return
    const t = this.stateOf(mode)
    const q = planar(mode, p)
    const target = mode === 'height' ? heightAt(this.session.doc, this.sampler, p.x, p.z) : 0 // can throw: before the gesture opens
    this.session.begin(`${mode} ${t.tool}`)
    this.stroke = { spacer: new DabSpacer(dabSpacing(t.settings.radius)), target }
    this.dabAlong(q, invert)
  }

  /** Continues the stroke to `p`. */
  move(p: Point3, invert: boolean): void {
    if (!this.stroke) return
    if (!this.session.inGesture) { this.stroke = null; return } // Esc or Ctrl+Z cancelled the gesture
    this.dabAlong(planar(this.modeValue as BrushMode, p), invert)
  }

  /** Places the dabs from the last point to `q`; if one throws, the stroke is abandoned and the error rethrown. */
  private dabAlong(q: Point3, invert: boolean): void {
    const s = this.stroke!
    try {
      let doc = this.session.doc
      for (const d of s.spacer.to(q)) {
        const layers = this.dab(doc, d, invert, s.target)
        if (layers !== doc.layers) doc = { ...doc, layers }
      }
      if (doc !== this.session.doc) this.session.update(() => doc)
    } catch (err) {
      this.cancel()
      throw err
    }
  }

  /** Ends the stroke: one undo step. */
  end(): void {
    if (!this.stroke) return
    this.stroke = null
    if (this.session.inGesture) this.session.commit()
  }

  /** Abandons the stroke: the document returns to where it began. */
  cancel(): void {
    if (!this.stroke) return
    this.stroke = null
    if (this.session.inGesture) this.session.cancel()
  }

  /** A whole stroke through `points` (tests, the e2e and scripts). */
  strokeThrough(points: readonly Point3[], invert = false): void {
    const [first, ...rest] = points
    if (!first) return
    this.begin(first, invert)
    for (const p of rest) this.move(p, invert)
    this.end()
  }

  private dab(doc: TerrainDoc, q: Point3, invert: boolean, target: number): TerrainLayers {
    switch (this.modeValue) {
      case 'height': {
        const t = this.stateOf('height')
        return heightDab(doc, this.sampler, { tool: t.tool as HeightTool, x: q.x, z: q.z, settings: t.settings, invert, target })
      }
      case 'biome': {
        const t = this.stateOf('biome')
        return biomeDab(doc, { x: q.x, z: q.z, radius: t.settings.radius, value: t.tool === 'erase' ? 0 : Math.min(this.biomeValue, doc.biomes.length) })
      }
      case 'density': {
        const t = this.stateOf('density')
        return densityDab(doc, this.sampler, { tool: t.tool as DensityTool, x: q.x, y: q.y, z: q.z, settings: t.settings, invert })
      }
      default:
        return doc.layers
    }
  }

  private stateOf(m: BrushMode): ToolState<string> {
    const b = this.tools[m] as Brush<string>
    return { tool: b.tool, settings: b.settings[b.tool]! }
  }

  private emit(): void { for (const fn of this.changeFns) fn() }
}
