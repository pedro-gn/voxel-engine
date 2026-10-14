import { defineGenerator, defineSystem, packVoxel, type SystemContext } from '@elovox/engine/sim-worker'
import type { WorkerOptions } from '@elovox/engine'

/** A floating island in a void world (spec §3 of the game hooks): 256² wide, 96 high. */
export const SKY_SIZE = [256, 96, 256] as const
export const SKY_CENTRE = 128
/** Island radius before noise; the west side carries an overhanging shelf beyond it. */
export const SKY_RADIUS = 70
/** The spring at the head of the stream that runs east and falls off the edge. */
export const SKY_SPRING = { x: 150, z: 128 } as const
export const SKY_WORKER_OPTIONS: WorkerOptions = {
  maxUnits: 64,
  materials: {
    stone: { digTicks: 16, buildTicks: 10 },
    dirt: { digTicks: 8, buildTicks: 6 },
    grass: { digTicks: 8, buildTicks: 6 },
  },
}

type Noise = (x: number, z: number) => number // [0, 1)
export type SkyBlock = 'stone' | 'dirt' | 'grass' | 'spring'

/** The stream's bed height at world x (falls one block every 8 toward the east edge). */
const streamBed = (x: number) => 50 - Math.floor((x - SKY_SPRING.x) / 8)

/** One column of the island, bottom to top (index = y); null is air. Pure: the same (x, z, noise) gives the same column. */
export function skyColumn(x: number, z: number, noise: Noise): (SkyBlock | null)[] {
  const col = new Array<SkyBlock | null>(SKY_SIZE[1]).fill(null)
  const dx = x - SKY_CENTRE, dz = z - SKY_CENTRE, r = Math.hypot(dx, dz)
  // West shelf: the edge reaches up to 14 blocks further out on the -x side, over a thin underside (the overhang).
  const west = Math.max(0, -dx / (r || 1))
  const edge = SKY_RADIUS * (0.92 + noise(x / 16, z / 16) * 0.16) + 14 * west * west
  if (r >= edge) return col
  const s = Math.min(1, r / SKY_RADIUS)
  let top = Math.round(54 + (noise(x / 12 + 7, z / 12) - 0.5) * 6 - s * 4)
  // A tapered underside: deep under the middle, thin at the rim, a 3-block shelf beyond the main body.
  let bottom = r > SKY_RADIUS ? top - 3 : Math.round(top - 4 - (1 - s * s) * 30)
  // The stream: a groove from the spring to the east edge, its bed falling toward the edge, walled on both sides.
  const inStream = x >= SKY_SPRING.x && Math.abs(z - SKY_SPRING.z) <= 1
  const bank = x >= SKY_SPRING.x - 2 && Math.abs(z - SKY_SPRING.z) <= 3 && !inStream
  if (inStream) top = streamBed(x)
  else if (bank) top = Math.max(top, streamBed(Math.max(x, SKY_SPRING.x)) + 2)
  bottom = Math.max(1, Math.min(bottom, top - 3))
  for (let y = bottom; y <= top; y++) col[y] = y === top && !inStream ? 'grass' : y >= top - 3 ? 'dirt' : 'stone'
  if (x === SKY_SPRING.x && z === SKY_SPRING.z) col[top + 1] = 'spring'
  return col
}

export const skyGenerator = defineGenerator({
  configure: () => ({ void: true }),
  generateColumn(ctx, cx, cz) {
    const ids: Record<SkyBlock, number> = { stone: ctx.id('stone'), dirt: ctx.id('dirt'), grass: ctx.id('grass'), spring: packVoxel(ctx.id('spring'), 4) }
    const noise: Noise = (x, z) => ctx.noise2(x, z)
    for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) {
      const col = skyColumn(cx * 32 + lx, cz * 32 + lz, noise)
      for (let y = 0; y < col.length; y++) { const b = col[y]; if (b) ctx.column[lx + (lz << 5) + (y << 10)] = ids[b] }
    }
  },
})

/** What the wander demo publishes every PUBLISH_TICKS. */
export interface WanderStats { units: number; dug: number; built: number; died: number }
interface WanderState { ids: number[]; dug: number; built: number; died: number; pending: { id: number; pos: [number, number, number]; voxel: number }[] }
export const WANDER_UNITS = 3
const PUBLISH_TICKS = 20
/** Where wander units roam: within this distance of the centre. */
const ROAM = 45

/** The highest solid block of column (x, z) under open air; -1 when the column is empty or wet on top. */
function topAt(c: SystemContext, x: number, z: number): number {
  for (let y = c.layout.size[1] - 2; y > 0; y--) {
    const v = c.get(x, y, z)
    if (c.isLiquid(v)) return -1
    if (c.isSolid(v)) return y
  }
  return -1
}
function randomPoint(c: SystemContext): [number, number] {
  const a = c.random() * Math.PI * 2, d = c.random() * ROAM
  return [Math.round(SKY_CENTRE + Math.cos(a) * d), Math.round(SKY_CENTRE + Math.sin(a) * d)]
}

/**
 * A game-system demo (spec §2): three controlled units walk to random points on the island, now and then dig the block under
 * one and later build it back. Uses only `ctx.units` and `ctx.random()`; its state is plain JSON.
 */
export function createWander() {
  let st: WanderState = { ids: [], dug: 0, built: 0, died: 0, pending: [] }
  const choose = (c: SystemContext, id: number) => {
    const back = st.pending.findIndex(p => p.id === id)
    if (back >= 0) { const p = st.pending.splice(back, 1)[0]!; c.units.build(id, p.pos, p.voxel); return }
    const [x, z] = randomPoint(c), y = topAt(c, x, z)
    if (y < 0) return // the next tick tries another point
    if (c.random() < 0.3) c.units.dig(id, [x, y, z])
    else c.units.goTo(id, [x, y + 1, z])
  }
  return defineSystem<WanderState, WanderStats>({
    name: 'wander',
    version: 1,
    init(c) {
      st = { ids: [], dug: 0, built: 0, died: 0, pending: [] }
      for (let tries = 0; st.ids.length < WANDER_UNITS && tries < 200; tries++) {
        const x = SKY_CENTRE - 6 + Math.floor(c.random() * 12), z = SKY_CENTRE - 6 + Math.floor(c.random() * 12), y = topAt(c, x, z)
        if (y < 0) continue
        try { st.ids.push(c.units.spawn([x, y + 1, z])) } catch { /* not a safe pose: try another */ }
      }
    },
    restore(_c, s) { st = { ids: [...s.ids], dug: s.dug, built: s.built, died: s.died, pending: s.pending.map(p => ({ ...p, pos: [...p.pos] as [number, number, number] })) } },
    tick(c) {
      for (const e of c.units.events) {
        if (e.type === 'dug') { st.dug++; st.pending.push({ id: e.unit, pos: [e.pos[0], e.pos[1], e.pos[2]], voxel: e.voxel }) }
        else if (e.type === 'built') st.built++
        else if (e.type === 'died') { st.died++; st.ids = st.ids.filter(id => id !== e.unit); st.pending = st.pending.filter(p => p.id !== e.unit) }
      }
      for (const id of st.ids) {
        const v = c.units.view(id)
        if (v && !v.intent && v.state !== 'falling' && v.state !== 'incapacitated') choose(c, id)
      }
    },
    snapshot: () => ({ ids: [...st.ids], dug: st.dug, built: st.built, died: st.died, pending: st.pending.map(p => ({ ...p, pos: [...p.pos] as [number, number, number] })) }),
    publish: c => c.tick % PUBLISH_TICKS === 0 ? { units: st.ids.length, dug: st.dug, built: st.built, died: st.died } : undefined,
  })
}
