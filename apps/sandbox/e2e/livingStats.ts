/** Pure statistics of the living-world benchmark: one phase window's result, the worse of two runs, and window checks. */
export type Phase = 'idle-default' | 'idle-far' | 'work-default' | 'work-far' | 'dam' | 'collapse'
export interface PhaseResult {
  phase: Phase; windowMs: number; frames: number
  fpsMedian: number; fpsP5: number; fpsMin: number; cpuMedian: number; cpuP95: number; gpuMs: number | null
  ticks: number; tickP95: number; tickMax: number; applyP95: number; applyMax: number
  maxDraws: number; maxShadowCasters: number; maxDecorationInstances: number; maxSearches: number; maxFragments: number
  maxWaterColumns: number; maxMeshQueue: number
  /** Units working, walking or planning, averaged over the window's ticks. */
  meanActiveUnits: number
  /** The mesh queue drained before the window started. */
  settled: boolean
  /** Unit states at the end of the window. */
  unitStates: Record<string, number>
}

const LOW = ['fpsMedian', 'fpsP5', 'fpsMin', 'meanActiveUnits'] as const
const HIGH = ['cpuMedian', 'cpuP95', 'tickP95', 'tickMax', 'applyP95', 'applyMax', 'maxDraws', 'maxShadowCasters', 'maxDecorationInstances', 'maxSearches', 'maxFragments', 'maxWaterColumns', 'maxMeshQueue'] as const

/** The worse of two runs of one phase, metric by metric: lowest fps and activity, highest costs and counters, settled only if both were. */
export function worseOf(a: PhaseResult, b: PhaseResult): PhaseResult {
  const out: PhaseResult = { ...a, frames: Math.min(a.frames, b.frames), settled: a.settled && b.settled }
  for (const k of LOW) out[k] = Math.min(a[k], b[k])
  for (const k of HIGH) out[k] = Math.max(a[k], b[k])
  out.gpuMs = a.gpuMs === null ? b.gpuMs : b.gpuMs === null ? a.gpuMs : Math.max(a.gpuMs, b.gpuMs)
  return out
}

/** A visible browser draws at least this many frames per second; fewer means rAF was throttled (an occluded window). */
const MIN_FPS = 5
/** Why a window does not measure what its phase claims; [] when it does. */
export function problems(r: PhaseResult): string[] {
  const out: string[] = []
  if (r.frames < (r.windowMs / 1000) * MIN_FPS) out.push(`throttled: ${r.frames} frames in ${r.windowMs} ms`)
  if (r.phase === 'collapse' && r.maxFragments === 0) out.push('no collapse fragment in the collapse window')
  if ((r.phase === 'work-default' || r.phase === 'work-far' || r.phase === 'dam' || r.phase === 'collapse') && r.meanActiveUnits < 1) out.push('less than one unit working, walking or planning on average')
  return out
}
