# AABB Collision (4c) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the engine a pure, time-agnostic AABB-vs-voxel collision service (`interact/collision.ts`, bound as `engine.collision`) that the first-person controller (4d) builds on.

**Architecture:** One module of pure functions over a `CollisionWorld {size, get, solid, liquid, source}`. An exact per-axis slab sweep (Y, then the larger horizontal axis) is the single primitive. Move with step-up, ground, overlap and unstick are built from it, and liquid queries read the voxel water mirror. `bindCollision` closes the functions over one world, and `engine.ts` binds it to the ghost-aware `world.get` and the registry tables.

**Tech Stack:** TypeScript 7 (strict, `allowImportingTsExtensions`), vitest 4, Node. No three.js or DOM in the module.

**Spec:** `docs/superpowers/specs/2026-10-08-collision-design.md` (approved in full at 68eff31). The API in spec §3 is frozen: any change goes through the expert.

## Global Constraints

- Module path: `packages/engine/src/interact/collision.ts`. Never name anything "physics".
- Pure functions in the style of `raycast.ts`: no DOM, no three.js, no `Math.hypot`, float64, world blocks, y up.
- Voxel (x, y, z) occupies [x, x+1) × [y, y+1) × [z, z+1).
- `CONTACT_EPS = 1e-7`, `GROUND_EPS = 1e-3`.
- Bounds: x < 0, x ≥ size[0], z < 0, z ≥ size[2] or y < 0 is solid; y ≥ size[1] is air (inside the x/z bounds).
- Solid = `registry.solid` by `voxelId`. Liquids are never solid.
- Liquid fill: 0 for a non-liquid, 1 for a spring (`source`), else `((state & 7) + 1) / 8`, with the water at the bottom of the cell.
- Shared files: `engine.ts` gets exactly three additive hunks (an import line, the interface member, the binding + the public member), and `index.ts` gets one appended export line. No reformatting or reordering.
- Commits: `type(scope): message`, no Co-Authored-By trailer, never push or merge.
- Under a HOLD from the expert, run only single test files (`npx vitest run test/collision.test.ts`), no full suites and no repo-wide tsc.

## Review Focus

1. **Creeping through a wall by tiny steps.** A controller applies gravity or input as many tiny displacements (< CONTACT_EPS) against a touching face. They must never accumulate into a penetration that the escape rule then treats as "already inside" (Task 2, the creep test).
2. **Huge or degenerate inputs hanging the loop.** A body far above the world falling by 1e12, a zero-width box exactly on a grid plane moving 1e4, or `unstick` with maxUp 1e9 on a box outside the world must all terminate (Tasks 1, 2, 4).
3. **Step-up producing a negative or phantom rise.** A ledge followed by a hole drops back fully and `stepped` stays 0, never negative. A diagonal against a tall wall must not bob (Task 3).
4. **Signed zero in results.** `groundDistance` on a resting box must return +0, not −0, because `toBe(0)` and callers comparing with `Object.is` would break (Task 3).
5. **Ghost edits.** A predicted block collides before its ack, and a predicted removal lets the body through (Task 6).

---

## File Structure

- Create `packages/engine/src/interact/collision.ts`: the whole API (types, constants, sweep, move, ground, overlap, unstick, liquid, bind). About 250 lines, one responsibility: box-vs-voxel geometry.
- Create `packages/engine/test/collision.test.ts`: all unit tests, with a small fake world.
- Modify `packages/engine/src/engine.ts`: an import line, `readonly collision: Collision` in `Engine`, the binding beside `pickable`, `collision,` after `raycast: rc,`.
- Modify `packages/engine/src/index.ts`: one appended export line.

All commands run from `packages/engine` in the worktree `C:\Users\pedro\Desktop\Projetos\voxel-engine\.claude\worktrees\collision`.

---

### Task 1: Types, cell rules and the overlap test

**Files:**
- Create: `packages/engine/src/interact/collision.ts`
- Test: `packages/engine/test/collision.test.ts`

**Interfaces:**
- Produces: `Box`, `CollisionWorld`, `SweepResult`, `MoveOptions`, `MoveResult`, `LiquidInfo`, `Collision`, `CONTACT_EPS`, `GROUND_EPS`, `bodyBox`, `boxOverlapsSolid`; internal `Bounds`, `bounds(box)`, `firstCell(lo)`, `lastCell(lo, hi)`, `anySolid(w, x0, x1, y0, y1, z0, z1)`, `boxSolid(w, b)`.

- [ ] **Step 1: Write the failing tests** (create the test file with its fake world)

```ts
import { describe, expect, it } from 'vitest'
import { BlockRegistry, defineBlock } from '../src/blocks/registry.ts'
import {
  bodyBox, boxOverlapsSolid,
  type Box, type CollisionWorld,
} from '../src/interact/collision.ts'
import type { WorldSize } from '../src/world/layout.ts'
import { ID, TEST_BLOCKS } from './helpers.ts'

const REG = new BlockRegistry([...TEST_BLOCKS, defineBlock({ name: 'spring', textures: 'water', liquid: true, source: 'water' })])
const STONE = ID.stone, WATER = ID.water, SPRING = 8

function makeWorld(size: WorldSize = [64, 64, 64]) {
  const cells = new Map<number, number>()
  const key = (x: number, y: number, z: number) => x + z * size[0] + y * size[0] * size[2]
  const world: CollisionWorld = { size, get: (x, y, z) => cells.get(key(x, y, z)) ?? 0, solid: REG.solid, liquid: REG.liquid, source: REG.source }
  const set = (x: number, y: number, z: number, v: number) => { cells.set(key(x, y, z), v) }
  const fill = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, v: number) => {
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) set(x, y, z, v)
  }
  return { world, set, fill }
}
/** The standard test body: 0.6 wide, 1.8 tall, feet centre (x, y, z). */
const body = (x: number, y: number, z: number): Box => bodyBox(x, y, z, 0.3, 1.8)

describe('bodyBox and boxOverlapsSolid', () => {
  it('builds a feet-centred box', () => {
    expect(bodyBox(10.5, 5, 10.5, 0.3, 1.8)).toEqual({ minX: 10.5 - 0.3, minY: 5, minZ: 10.5 - 0.3, maxX: 10.5 + 0.3, maxY: 5 + 1.8, maxZ: 10.5 + 0.3 })
  })
  it('overlaps a solid voxel inside the box, never a liquid one', () => {
    const { world, set } = makeWorld()
    set(10, 6, 10, WATER)
    expect(boxOverlapsSolid(world, body(10.5, 5, 10.5))).toBe(false)
    set(10, 6, 10, STONE)
    expect(boxOverlapsSolid(world, body(10.5, 5, 10.5))).toBe(true)
  })
  it('does not count touching faces or float residue as overlap', () => {
    const { world, set } = makeWorld()
    set(10, 4, 10, STONE); set(11, 5, 10, STONE)
    expect(boxOverlapsSolid(world, body(10.5, 5, 10.5))).toBe(false)
    expect(boxOverlapsSolid(world, body(10.5, 5 - 1e-9, 10.5))).toBe(false)
    expect(boxOverlapsSolid(world, body(10.7, 5, 10.5))).toBe(false)
    expect(boxOverlapsSolid(world, body(10.701, 5, 10.5))).toBe(true)
  })
  it('treats the sides and the floor as solid and above the top as air', () => {
    const { world } = makeWorld()
    expect(boxOverlapsSolid(world, body(0.2, 5, 10.5))).toBe(true)
    expect(boxOverlapsSolid(world, body(63.8, 5, 10.5))).toBe(true)
    expect(boxOverlapsSolid(world, body(10.5, 5, 0.2))).toBe(true)
    expect(boxOverlapsSolid(world, body(10.5, 5, 63.8))).toBe(true)
    expect(boxOverlapsSolid(world, body(10.5, -0.1, 10.5))).toBe(true)
    expect(boxOverlapsSolid(world, body(10.5, 0, 10.5))).toBe(false)
    expect(boxOverlapsSolid(world, body(10.5, 63, 10.5))).toBe(false)
    expect(boxOverlapsSolid(world, body(10.5, 1e9, 10.5))).toBe(false)
    expect(boxOverlapsSolid(world, body(63.8, 100, 10.5))).toBe(true)
  })
  it('a non-finite box overlaps nothing', () => {
    const { world } = makeWorld()
    expect(boxOverlapsSolid(world, body(NaN, 5, 10.5))).toBe(false)
    expect(boxOverlapsSolid(world, { ...body(10.5, 5, 10.5), maxY: Infinity })).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/collision.test.ts`
Expected: FAIL, because `../src/interact/collision.ts` does not exist.

- [ ] **Step 3: Implement**

```ts
import type { WorldSize } from '../world/layout.ts'
import { voxelId } from '../world/voxel.ts'
import type { Vec3Like } from './raycast.ts'

/** An axis-aligned box in world blocks. Voxel (x, y, z) occupies [x, x+1) × [y, y+1) × [z, z+1). */
export interface Box {
  readonly minX: number; readonly minY: number; readonly minZ: number
  readonly maxX: number; readonly maxY: number; readonly maxZ: number
}
/** What collision reads. `solid`, `liquid` and `source` are the registry's per-id tables. */
export interface CollisionWorld {
  readonly size: WorldSize
  get(x: number, y: number, z: number): number
  readonly solid: Uint8Array
  readonly liquid: Uint8Array
  readonly source: Uint8Array
}
/** Faces closer than this are touching, not overlapping (absorbs float residue at contact). */
export const CONTACT_EPS = 1e-7
/** A box is grounded when solid lies within this distance below it. */
export const GROUND_EPS = 1e-3

export interface SweepResult {
  /** The allowed displacement. */
  dx: number; dy: number; dz: number
  /** That axis moved less than requested. */
  blockedX: boolean; blockedY: boolean; blockedZ: boolean
}
export interface MoveOptions { /** Highest ledge climbed without a jump; default 0 (no step-up). */ stepHeight?: number }
export interface MoveResult extends SweepResult {
  /** After the move, solid lies within GROUND_EPS below the box. */
  grounded: boolean
  /** A positive dy was stopped by solid above. */
  ceiling: boolean
  /** Rise added by step-up, already included in dy; 0 when no step was taken. For camera smoothing. */
  stepped: number
}
export interface LiquidInfo {
  /** Liquid height inside [minY, maxY] over the box height, 0..1: the max over the columns the footprint overlaps. */
  submerged: number
  /** eyeY was given and the point (box centre x, eyeY, box centre z) is under a liquid surface. */
  eyeUnder: boolean
  /** Top of the highest liquid run touching the box in the column that gave `submerged`; null when dry. */
  surfaceY: number | null
}
/** The functions bound to one world; what `engine.collision` is. */
export interface Collision {
  sweep(box: Box, delta: Vec3Like, out?: SweepResult): SweepResult
  move(box: Box, delta: Vec3Like, options?: MoveOptions, out?: MoveResult): MoveResult
  overlaps(box: Box): boolean
  groundDistance(box: Box, maxDown?: number): number | null
  liquid(box: Box, eyeY?: number): LiquidInfo
  liquidAt(x: number, y: number, z: number): boolean
  unstick(box: Box, maxUp: number): number | null
}

/** The box of a body whose feet centre is (x, y, z): [x−hw, x+hw] × [y, y+height] × [z−hw, z+hw]. */
export function bodyBox(x: number, y: number, z: number, halfWidth: number, height: number): Box {
  return { minX: x - halfWidth, minY: y, minZ: z - halfWidth, maxX: x + halfWidth, maxY: y + height, maxZ: z + halfWidth }
}

/** A working copy of a box: min x, y, z at 0..2, max x, y, z at 3..5. */
type Bounds = [number, number, number, number, number, number]

/** The box as Bounds, or null when any bound is not finite. */
function bounds(box: Box): Bounds | null {
  const b: Bounds = [box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ]
  for (const v of b) if (!Number.isFinite(v)) return null
  return b
}

/** The first cell an interval starting at lo overlaps: residue within CONTACT_EPS of a face is not overlap. */
function firstCell(lo: number): number { return Math.floor(lo + CONTACT_EPS) }
/** The last cell [lo, hi] overlaps; a degenerate interval counts as the cell holding lo, so ranges are never empty. */
function lastCell(lo: number, hi: number): number { return Math.max(firstCell(lo), Math.ceil(hi - CONTACT_EPS) - 1) }

/** Whether the inclusive cell range holds solid: outside the world's sides or floor is solid, above its top is air. */
function anySolid(w: CollisionWorld, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): boolean {
  const [sx, sy, sz] = w.size
  if (x0 < 0 || z0 < 0 || y0 < 0 || x1 >= sx || z1 >= sz) return true
  const top = Math.min(y1, sy - 1)
  for (let y = y0; y <= top; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
    if (w.solid[voxelId(w.get(x, y, z))] === 1) return true
  }
  return false
}

function boxSolid(w: CollisionWorld, b: Bounds): boolean {
  return anySolid(w, firstCell(b[0]), lastCell(b[0], b[3]), firstCell(b[1]), lastCell(b[1], b[4]), firstCell(b[2]), lastCell(b[2], b[5]))
}

export function boxOverlapsSolid(w: CollisionWorld, box: Box): boolean {
  const b = bounds(box)
  return b !== null && boxSolid(w, b)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/collision.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/interact/collision.ts packages/engine/test/collision.test.ts
git commit -m "feat(collision): box types, cell rules and the overlap test"
```

---

### Task 2: The swept move (`sweepBox`)

**Files:**
- Modify: `packages/engine/src/interact/collision.ts` (append)
- Test: `packages/engine/test/collision.test.ts` (append; add `sweepBox, CONTACT_EPS, type SweepResult` to the import)

**Interfaces:**
- Consumes: `Bounds`, `bounds`, `firstCell`, `lastCell`, `anySolid`, `boxSolid` (Task 1).
- Produces: `sweepBox(w, box, delta, out?)`; internal `sweepAxis(w, b, a, d): number` (moves `b` in place and returns the distance), `delta3(d): [number, number, number]`, `Horizontal`, `sweepHorizontal(w, b, dx, dz, out)`.

- [ ] **Step 1: Write the failing tests**

```ts
/** The box after a result's displacement. */
const after = (b: Box, r: SweepResult): Box =>
  ({ minX: b.minX + r.dx, minY: b.minY + r.dy, minZ: b.minZ + r.dz, maxX: b.maxX + r.dx, maxY: b.maxY + r.dy, maxZ: b.maxZ + r.dz })

describe('sweepBox', () => {
  it('moves freely through air', () => {
    const { world } = makeWorld()
    expect(sweepBox(world, body(10.5, 10, 10.5), [1, 2, -0.5])).toEqual({ dx: 1, dy: 2, dz: -0.5, blockedX: false, blockedY: false, blockedZ: false })
  })
  it('stops each face exactly on the voxel plane', () => {
    const { world, set } = makeWorld()
    set(12, 10, 10, STONE); set(8, 10, 10, STONE); set(10, 10, 12, STONE); set(10, 10, 8, STONE)
    set(10, 13, 10, STONE); set(10, 4, 10, STONE)
    const b = body(10.5, 10, 10.5)
    const px = sweepBox(world, b, [5, 0, 0]); expect(b.maxX + px.dx).toBeCloseTo(12, 9); expect(px.blockedX).toBe(true)
    const nx = sweepBox(world, b, [-5, 0, 0]); expect(b.minX + nx.dx).toBeCloseTo(9, 9); expect(nx.blockedX).toBe(true)
    const pz = sweepBox(world, b, [0, 0, 5]); expect(b.maxZ + pz.dz).toBeCloseTo(12, 9); expect(pz.blockedZ).toBe(true)
    const nz = sweepBox(world, b, [0, 0, -5]); expect(b.minZ + nz.dz).toBeCloseTo(9, 9); expect(nz.blockedZ).toBe(true)
    const py = sweepBox(world, b, [0, 5, 0]); expect(b.maxY + py.dy).toBeCloseTo(13, 9); expect(py.blockedY).toBe(true)
    const ny = sweepBox(world, b, [0, -20, 0]); expect(b.minY + ny.dy).toBeCloseTo(5, 9); expect(ny.blockedY).toBe(true)
    for (const r of [px, nx, pz, nz, py, ny]) expect(boxOverlapsSolid(world, after(b, r))).toBe(false)
  })
  it('never tunnels through a one-voxel wall or floor, at any length', () => {
    const { world, fill } = makeWorld()
    fill(20, 0, 0, 20, 30, 30, STONE) // wall at x = 20
    fill(0, 3, 40, 30, 3, 60, STONE)  // floor at y = 3, under z 40..60
    for (const d of [0.9, 10, 1e4]) {
      const b = body(19.2, 10, 10.5) // maxX = 19.5
      const r = sweepBox(world, b, [d, 0, 0])
      expect(b.maxX + r.dx).toBeCloseTo(20, 9)
      expect(r.blockedX).toBe(true)
    }
    const fall = sweepBox(world, body(10.5, 50, 50.5), [0, -1e4, 0])
    expect(50 + fall.dy).toBeCloseTo(4, 9)
  })
  it('stops across a chunk border', () => {
    const { world, set } = makeWorld()
    set(32, 10, 10, STONE)
    const b = body(30.5, 10, 10.5)
    expect(b.maxX + sweepBox(world, b, [100, 0, 0]).dx).toBeCloseTo(32, 9)
  })
  it('stops at the world sides and floor, and lets the box rise above the top and come back', () => {
    const { world } = makeWorld()
    const b = body(2.5, 10, 2.5)
    expect(b.minX + sweepBox(world, b, [-100, 0, 0]).dx).toBeCloseTo(0, 9)
    expect(b.minZ + sweepBox(world, b, [0, 0, -100]).dz).toBeCloseTo(0, 9)
    const e = body(61.5, 10, 61.5)
    expect(e.maxX + sweepBox(world, e, [100, 0, 0]).dx).toBeCloseTo(64, 9)
    expect(e.maxZ + sweepBox(world, e, [0, 0, 100]).dz).toBeCloseTo(64, 9)
    expect(10 + sweepBox(world, b, [0, -100, 0]).dy).toBeCloseTo(0, 9)
    const up = sweepBox(world, body(10.5, 60, 10.5), [0, 100, 0])
    expect(up).toMatchObject({ dy: 100, blockedY: false })
    const back = sweepBox(world, body(10.5, 160, 10.5), [0, -200, 0])
    expect(160 + back.dy).toBeCloseTo(0, 9)
  })
  it('terminates on huge vertical displacements', () => {
    const { world } = makeWorld()
    expect(sweepBox(world, body(10.5, 10, 10.5), [0, 1e12, 0]).dy).toBe(1e12)
    expect(1e12 + sweepBox(world, body(10.5, 1e12, 10.5), [0, -2e12, 0]).dy).toBeCloseTo(0, 0)
  })
  it('slides along a wall when moving diagonally', () => {
    const { world, fill } = makeWorld()
    fill(12, 10, 0, 12, 11, 30, STONE)
    const r = sweepBox(world, body(10.5, 10, 10.5), [5, 0, 3])
    expect(10.8 + r.dx).toBeCloseTo(12, 9)
    expect(r).toMatchObject({ dz: 3, blockedX: true, blockedZ: false })
  })
  it('sweeps the larger horizontal axis first, x on a tie', () => {
    const { world, set } = makeWorld()
    set(12, 10, 12, STONE)
    const zFirst = sweepBox(world, body(10.5, 10, 10.5), [2, 0, 2.5])
    expect(zFirst.dz).toBe(2.5); expect(10.8 + zFirst.dx).toBeCloseTo(12, 9)
    const tie = sweepBox(world, body(10.5, 10, 10.5), [2, 0, 2])
    expect(tie.dx).toBe(2); expect(10.8 + tie.dz).toBeCloseTo(12, 9)
  })
  it('passes a gap exactly as wide as the box and stops at a narrower one', () => {
    const { world, fill } = makeWorld()
    fill(10, 10, 12, 10, 12, 30, STONE); fill(12, 10, 12, 12, 12, 30, STONE) // a corridor x in [11, 12) from z = 12
    expect(sweepBox(world, bodyBox(11.5, 10, 9.5, 0.5, 1.8), [0, 0, 10]).dz).toBe(10)
    const wide = bodyBox(11.5, 10, 9.5, 0.6, 1.8)
    expect(wide.maxZ + sweepBox(world, wide, [0, 0, 10]).dz).toBeCloseTo(12, 9)
  })
  it('slides on a floor it rests on with float residue', () => {
    const { world, fill, set } = makeWorld()
    fill(0, 4, 0, 30, 4, 30, STONE)
    expect(sweepBox(world, body(10.5, 5 - 1e-9, 10.5), [3, 0, 0])).toMatchObject({ dx: 3, blockedX: false })
    set(12, 5, 10, STONE)
    const touching = { ...body(10.5, 5, 10.5), minX: 11.4 + 5e-8, maxX: 12 + 5e-8 }
    expect(sweepBox(world, touching, [1, 0, 0])).toMatchObject({ dx: 0, blockedX: true })
    expect(sweepBox(world, touching, [-1, 0, 0])).toMatchObject({ dx: -1, blockedX: false })
  })
  it('never creeps into a wall through many tiny steps', () => {
    const { world, set } = makeWorld()
    set(12, 10, 10, STONE)
    let b: Box = { ...body(10.5, 10, 10.5), minX: 11.4, maxX: 12 }
    for (let i = 0; i < 1000; i++) b = after(b, sweepBox(world, b, [1e-8, 0, 0]))
    expect(b.maxX).toBeLessThan(12 + CONTACT_EPS)
    expect(sweepBox(world, b, [1, 0, 0]).dx).toBe(0)
  })
  it('lets a box escape a block edited into it, but never into new solid', () => {
    const { world, set } = makeWorld()
    set(10, 10, 10, STONE)
    const b = body(10.5, 10, 10.5)
    expect(sweepBox(world, b, [3, 0, 0]).dx).toBe(3)
    expect(sweepBox(world, b, [-3, 0, 0]).dx).toBe(-3)
    set(12, 10, 10, STONE); set(8, 10, 10, STONE)
    expect(10.8 + sweepBox(world, b, [3, 0, 0]).dx).toBeCloseTo(12, 9)
    expect(10.2 + sweepBox(world, b, [-3, 0, 0]).dx).toBeCloseTo(9, 9)
  })
  it('a degenerate box on a grid plane still stops and terminates', () => {
    const { world, set } = makeWorld()
    set(12, 10, 10, STONE)
    const flat: Box = { minX: 10, minY: 10, minZ: 10, maxX: 10, maxY: 10, maxZ: 10 }
    expect(10 + sweepBox(world, flat, [1e4, 0, 0]).dx).toBeCloseTo(12, 9)
    expect(sweepBox(world, flat, [0, 0, 1e4]).dz).toBeCloseTo(54, 9)
  })
  it('treats non-finite input as no motion', () => {
    const { world } = makeWorld()
    expect(sweepBox(world, body(10.5, 10, 10.5), [NaN, Infinity, 1])).toEqual({ dx: 0, dy: 0, dz: 1, blockedX: false, blockedY: false, blockedZ: false })
    expect(sweepBox(world, body(NaN, 10, 10.5), { x: 1, y: 1, z: 1 })).toEqual({ dx: 0, dy: 0, dz: 0, blockedX: false, blockedY: false, blockedZ: false })
  })
  it('fills and returns the out object', () => {
    const { world } = makeWorld()
    const out: SweepResult = { dx: 9, dy: 9, dz: 9, blockedX: true, blockedY: true, blockedZ: true }
    expect(sweepBox(world, body(10.5, 10, 10.5), [1, 0, 0], out)).toBe(out)
    expect(out).toEqual({ dx: 1, dy: 0, dz: 0, blockedX: false, blockedY: false, blockedZ: false })
  })
})
```

In the larger-axis test, z first moves the box to z ∈ [12.7, 13.3], so the x sweep meets the block at (12, 10, 12); x first would pass it and the z sweep would stop at 12 instead. The degenerate z case: the stone at (12, 10, 10) does not sit in a flat box's column x = 10, so the box runs to the world side at z = 64 → dz = 54.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/collision.test.ts`
Expected: FAIL, because `sweepBox` is not exported.

- [ ] **Step 3: Implement** (append to `collision.ts`)

```ts
/** The delta as numbers; a non-finite component counts as 0. */
function delta3(d: Vec3Like): [number, number, number] {
  const [x, y, z] = 'x' in d ? [d.x, d.y, d.z] : [d[0], d[1], d[2]]
  return [Number.isFinite(x) ? x : 0, Number.isFinite(y) ? y : 0, Number.isFinite(z) ? z : 0]
}

/**
 * Moves b along axis a (0 x, 1 y, 2 z) by d and returns the distance moved. Every slab of cells the leading face
 * enters is checked (so no length tunnels); cells the box already overlaps are not (so it can leave them). The scan
 * starts with residue tolerance and ends strictly, so tiny steps never creep into a face they touch.
 */
function sweepAxis(w: CollisionWorld, b: Bounds, a: number, d: number): number {
  if (d === 0) return 0
  const u = a === 0 ? 1 : 0, v = a === 2 ? 1 : 2
  const u0 = firstCell(b[u]), u1 = lastCell(b[u], b[u + 3]), v0 = firstCell(b[v]), v1 = lastCell(b[v], b[v + 3])
  const slab = (c: number) => a === 0 ? anySolid(w, c, c, u0, u1, v0, v1)
    : a === 1 ? anySolid(w, u0, u1, c, c, v0, v1) : anySolid(w, u0, u1, v0, v1, c, c)
  const top = w.size[1]
  let moved = d
  if (d > 0) {
    const f = b[a + 3]
    for (let c = Math.ceil(f - CONTACT_EPS); c < f + d; c++) {
      if (slab(c)) { moved = Math.max(0, c - f); break }
      if (a === 1 && c >= top) break // air from here up: the cross-section is inside the world
    }
  } else {
    const f = b[a]
    let c = Math.floor(f + CONTACT_EPS) - 1
    if (a === 1 && c >= top && !slab(c)) c = top - 1 // skip the air above the world
    for (; c + 1 > f + d; c--) {
      if (slab(c)) { moved = Math.min(0, c + 1 - f); break }
    }
  }
  b[a] += moved
  b[a + 3] += moved
  return moved
}

interface Horizontal { dx: number; dz: number; blockedX: boolean; blockedZ: boolean }

/** The horizontal phase: the axis with the larger |delta| first, x on a tie. */
function sweepHorizontal(w: CollisionWorld, b: Bounds, dx: number, dz: number, out: Horizontal): void {
  if (Math.abs(dz) > Math.abs(dx)) {
    out.dz = sweepAxis(w, b, 2, dz)
    out.dx = sweepAxis(w, b, 0, dx)
  } else {
    out.dx = sweepAxis(w, b, 0, dx)
    out.dz = sweepAxis(w, b, 2, dz)
  }
  out.blockedX = out.dx !== dx
  out.blockedZ = out.dz !== dz
}

/** Moves the box by delta, y first, then the larger horizontal axis; returns the allowed displacement. */
export function sweepBox(w: CollisionWorld, box: Box, delta: Vec3Like, out?: SweepResult): SweepResult {
  const r = out ?? { dx: 0, dy: 0, dz: 0, blockedX: false, blockedY: false, blockedZ: false }
  const b = bounds(box)
  if (b === null) {
    r.dx = 0; r.dy = 0; r.dz = 0
    r.blockedX = false; r.blockedY = false; r.blockedZ = false
    return r
  }
  const [dx, dy, dz] = delta3(delta)
  r.dy = sweepAxis(w, b, 1, dy)
  r.blockedY = r.dy !== dy
  sweepHorizontal(w, b, dx, dz, r)
  return r
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/collision.test.ts`
Expected: PASS (20 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/interact/collision.ts packages/engine/test/collision.test.ts
git commit -m "feat(collision): exact per-axis swept move"
```

---

### Task 3: Ground query and the move with step-up (`groundDistance`, `moveBox`)

**Files:**
- Modify: `packages/engine/src/interact/collision.ts` (append)
- Test: `packages/engine/test/collision.test.ts` (append; add `groundDistance, moveBox` to the import)

**Interfaces:**
- Consumes: `sweepAxis`, `sweepHorizontal`, `Horizontal`, `delta3`, `bounds`, `Bounds` (Tasks 1–2).
- Produces: `groundDistance(w, box, maxDown?)`, `moveBox(w, box, delta, options?, out?)`; internal `resting(w, b): boolean`.

- [ ] **Step 1: Write the failing tests**

```ts
/** A stone floor whose top is y = 5 under x, z in [0, 31). */
function floored() {
  const t = makeWorld()
  t.fill(0, 4, 0, 30, 4, 30, STONE)
  return t
}

describe('groundDistance', () => {
  it('measures the drop to the support within maxDown', () => {
    const { world } = floored()
    expect(groundDistance(world, body(10.5, 5, 10.5))).toBe(0)
    expect(groundDistance(world, body(10.5, 5.0005, 10.5))).toBeCloseTo(0.0005, 9)
    expect(groundDistance(world, body(10.5, 5.5, 10.5))).toBeNull()
    expect(groundDistance(world, body(10.5, 5.5, 10.5), 1)).toBeCloseTo(0.5, 9)
    expect(groundDistance(world, body(40.5, 5, 40.5), 1)).toBeNull()
    expect(groundDistance(world, body(40.5, 0, 40.5))).toBe(0) // the world floor
    expect(groundDistance(world, body(10.5, 5.5, 10.5), NaN)).toBeNull() // falls back to GROUND_EPS
    expect(groundDistance(world, body(NaN, 5, 10.5))).toBeNull()
  })
})

describe('moveBox', () => {
  it('reports grounded, ceiling and blockedY', () => {
    const { world, set } = floored()
    const land = moveBox(world, body(10.5, 6, 10.5), [0, -2, 0])
    expect(land).toMatchObject({ blockedY: true, ceiling: false, grounded: true, stepped: 0 })
    expect(6 + land.dy).toBeCloseTo(5, 9)
    set(10, 8, 10, STONE)
    const bump = moveBox(world, body(10.5, 5, 10.5), [0, 2, 0])
    expect(bump).toMatchObject({ blockedY: true, ceiling: true, grounded: false })
    expect(6.8 + bump.dy).toBeCloseTo(8, 9)
    expect(moveBox(world, body(10.5, 5, 10.5), [1, 0, 0])).toMatchObject({ dx: 1, grounded: true, ceiling: false })
  })
  it('does not step without stepHeight', () => {
    const { world, fill } = floored()
    fill(12, 5, 0, 12, 5, 30, STONE)
    const r = moveBox(world, body(10.5, 5, 10.5), [2, -0.01, 0])
    expect(10.8 + r.dx).toBeCloseTo(12, 9)
    expect(r).toMatchObject({ blockedX: true, stepped: 0 })
  })
  it('climbs a one-block ledge with stepHeight 1 and 1.25', () => {
    const { world, fill } = floored()
    fill(12, 5, 0, 12, 5, 30, STONE)
    for (const stepHeight of [1, 1.25]) {
      const r = moveBox(world, body(10.5, 5, 10.5), [2, -0.01, 0], { stepHeight })
      expect(r).toMatchObject({ dx: 2, blockedX: false, grounded: true })
      expect(r.stepped).toBeCloseTo(1, 9)
      expect(r.dy).toBeCloseTo(1, 9)
      expect(boxOverlapsSolid(world, after(body(10.5, 5, 10.5), r))).toBe(false)
    }
  })
  it('refuses a ledge higher than stepHeight', () => {
    const { world, fill } = floored()
    fill(12, 5, 0, 12, 5, 30, STONE)
    expect(moveBox(world, body(10.5, 5, 10.5), [2, -0.01, 0], { stepHeight: 0.6 })).toMatchObject({ blockedX: true, stepped: 0, dy: 0 })
    fill(12, 6, 0, 12, 6, 30, STONE)
    expect(moveBox(world, body(10.5, 5, 10.5), [2, -0.01, 0], { stepHeight: 1 })).toMatchObject({ blockedX: true, stepped: 0, dy: 0 })
  })
  it('refuses a step with too little headroom, over the ledge or over the body', () => {
    const { world, fill } = floored()
    fill(12, 5, 0, 12, 5, 30, STONE)
    fill(12, 7, 0, 14, 7, 30, STONE) // a ceiling one block above the ledge top
    expect(moveBox(world, body(10.5, 5, 10.5), [2, -0.01, 0], { stepHeight: 1 })).toMatchObject({ blockedX: true, stepped: 0 })
    const low = floored()
    low.fill(12, 5, 0, 12, 5, 30, STONE)
    low.set(10, 7, 10, STONE) // a ceiling over the body: only 0.2 of lift
    expect(moveBox(low.world, body(10.5, 5, 10.5), [2, -0.01, 0], { stepHeight: 1 })).toMatchObject({ blockedX: true, stepped: 0 })
  })
  it('does not step in the air', () => {
    const { world, fill } = floored()
    fill(12, 5, 0, 12, 12, 30, STONE)
    fill(13, 5, 0, 13, 7, 30, STONE)
    const r = moveBox(world, body(10.5, 8, 10.5), [2, -0.01, 0], { stepHeight: 1 })
    expect(r).toMatchObject({ blockedX: true, stepped: 0, grounded: false })
  })
  it('steps after landing in the same move', () => {
    const { world, fill } = floored()
    fill(12, 5, 0, 12, 5, 30, STONE)
    const r = moveBox(world, body(10.5, 5.0005, 10.5), [2, -0.01, 0], { stepHeight: 1 })
    expect(r.dx).toBe(2)
    expect(5.0005 + r.dy).toBeCloseTo(6, 9)
  })
  it('does not bob against a tall wall when the other axis is free', () => {
    const { world, fill } = floored()
    fill(12, 5, 0, 12, 10, 30, STONE)
    const r = moveBox(world, body(10.5, 5, 10.5), [2, 0, 1], { stepHeight: 1 })
    expect(r).toMatchObject({ dz: 1, blockedX: true, stepped: 0, dy: 0 })
  })
  it('keeps stepped at 0, never negative, over a ledge followed by a hole', () => {
    const { world, fill } = makeWorld()
    fill(0, 4, 0, 12, 4, 30, STONE) // floor only up to x = 12
    fill(12, 5, 0, 12, 5, 30, STONE) // a one-wide ledge; beyond it a hole to the world floor
    const r = moveBox(world, body(10.5, 5, 10.5), [3, -0.01, 0], { stepHeight: 1 })
    expect(r.dx).toBe(3)
    expect(r.stepped).toBe(0)
    expect(r.dy).toBe(0)
    expect(r.grounded).toBe(false)
    expect(boxOverlapsSolid(world, after(body(10.5, 5, 10.5), r))).toBe(false)
  })
  it('treats non-finite input as no motion and fills the out object', () => {
    const { world } = floored()
    expect(moveBox(world, body(NaN, 5, 10.5), [1, 0, 0])).toMatchObject({ dx: 0, dy: 0, dz: 0, grounded: false, ceiling: false, stepped: 0 })
    const out = { dx: 9, dy: 9, dz: 9, blockedX: true, blockedY: true, blockedZ: true, grounded: false, ceiling: true, stepped: 9 }
    expect(moveBox(world, body(10.5, 5, 10.5), [1, 0, 0], { stepHeight: Infinity }, out)).toBe(out)
    expect(out).toEqual({ dx: 1, dy: 0, dz: 0, blockedX: false, blockedY: false, blockedZ: false, grounded: true, ceiling: false, stepped: 0 })
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/collision.test.ts`
Expected: FAIL, because `groundDistance` and `moveBox` are not exported.

- [ ] **Step 3: Implement** (append)

```ts
/** Solid lies within GROUND_EPS below b. */
function resting(w: CollisionWorld, b: Bounds): boolean {
  const probe: Bounds = [...b]
  return sweepAxis(w, probe, 1, -GROUND_EPS) !== -GROUND_EPS
}

/** How far the box drops before resting on solid, if within maxDown (default GROUND_EPS); null otherwise. */
export function groundDistance(w: CollisionWorld, box: Box, maxDown = GROUND_EPS): number | null {
  const b = bounds(box)
  if (b === null) return null
  const reach = Number.isFinite(maxDown) && maxDown > 0 ? maxDown : GROUND_EPS
  const moved = sweepAxis(w, b, 1, -reach)
  return moved === -reach ? null : 0 - moved // 0 − moved: never −0
}

/**
 * sweepBox plus step-up (spec §4 Step-up): when stepHeight > 0, a horizontal axis is blocked and the box rests on
 * solid after the y phase, it also tries lift → horizontal → drop by the lift, and keeps that path only if it gets
 * strictly further horizontally.
 */
export function moveBox(w: CollisionWorld, box: Box, delta: Vec3Like, options?: MoveOptions, out?: MoveResult): MoveResult {
  const r = out ?? { dx: 0, dy: 0, dz: 0, blockedX: false, blockedY: false, blockedZ: false, grounded: false, ceiling: false, stepped: 0 }
  r.grounded = false
  r.ceiling = false
  r.stepped = 0
  const start = bounds(box)
  if (start === null) { sweepBox(w, box, delta, r); return r }
  const [dx, dy, dz] = delta3(delta)
  let b = start
  r.dy = sweepAxis(w, b, 1, dy)
  r.blockedY = r.dy !== dy
  r.ceiling = r.blockedY && dy > 0
  const afterY: Bounds = [...b]
  sweepHorizontal(w, b, dx, dz, r)
  const stepHeight = options?.stepHeight ?? 0
  if (stepHeight > 0 && Number.isFinite(stepHeight) && (r.blockedX || r.blockedZ) && resting(w, afterY)) {
    const s: Bounds = [...afterY]
    const lift = sweepAxis(w, s, 1, stepHeight)
    const h: Horizontal = { dx: 0, dz: 0, blockedX: false, blockedZ: false }
    sweepHorizontal(w, s, dx, dz, h)
    const drop = sweepAxis(w, s, 1, -lift)
    if (h.dx * h.dx + h.dz * h.dz > r.dx * r.dx + r.dz * r.dz) {
      r.dx = h.dx; r.dz = h.dz
      r.blockedX = h.blockedX; r.blockedZ = h.blockedZ
      r.stepped = lift + drop
      r.dy += r.stepped
      b = s
    }
  }
  r.grounded = resting(w, b)
  return r
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/collision.test.ts`
Expected: PASS (31 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/interact/collision.ts packages/engine/test/collision.test.ts
git commit -m "feat(collision): ground query and move with step-up"
```

---

### Task 4: Unstick

**Files:**
- Modify: `packages/engine/src/interact/collision.ts` (append)
- Test: `packages/engine/test/collision.test.ts` (append; add `unstick` to the import)

**Interfaces:**
- Consumes: `bounds`, `boxSolid` (Task 1).
- Produces: `unstick(w, box, maxUp): number | null`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('unstick', () => {
  it('is 0 for a free box', () => {
    const { world } = floored()
    expect(unstick(world, body(10.5, 5, 10.5), 1)).toBe(0)
    expect(unstick(world, body(10.5, 5, 10.5), NaN)).toBe(0)
  })
  it('lifts a box out of a block edited in at its feet, within maxUp', () => {
    const { world, set } = floored()
    set(10, 5, 10, STONE)
    expect(unstick(world, body(10.5, 5, 10.5), 1.5)).toBe(1)
    expect(unstick(world, body(10.5, 5, 10.5), 0.5)).toBeNull()
    expect(unstick(world, body(10.5, 5.3, 10.5), 1)).toBeCloseTo(0.7, 9)
  })
  it('cannot clear a block in the head region with a small lift', () => {
    const { world, set } = floored()
    set(10, 6, 10, STONE)
    expect(unstick(world, body(10.5, 5, 10.5), 1.5)).toBeNull()
    expect(unstick(world, body(10.5, 5, 10.5), 2)).toBe(2)
  })
  it('accounts for a ceiling above', () => {
    const { world, set } = floored()
    set(10, 5, 10, STONE); set(10, 7, 10, STONE)
    expect(unstick(world, body(10.5, 5, 10.5), 1.5)).toBeNull()
    expect(unstick(world, body(10.5, 5, 10.5), 3)).toBe(3)
  })
  it('returns null for bad maxUp, a non-finite box, or a box outside the world, and terminates', () => {
    const { world, set } = floored()
    set(10, 5, 10, STONE)
    expect(unstick(world, body(10.5, 5, 10.5), -1)).toBeNull()
    expect(unstick(world, body(10.5, 5, 10.5), Infinity)).toBeNull()
    expect(unstick(world, body(NaN, 5, 10.5), 1)).toBeNull()
    expect(unstick(world, body(0.1, 5, 10.5), 1e9)).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/collision.test.ts`
Expected: FAIL, because `unstick` is not exported.

- [ ] **Step 3: Implement** (append)

```ts
/**
 * The smallest upward lift (≤ maxUp) after which the box overlaps no solid; 0 when it already overlaps none, null when
 * no lift up to maxUp frees it. Clearing a cell needs minY on that cell's top, so the candidates put minY on each
 * integer above it. Above the world's top only the sides can overlap, and lifting never clears those.
 */
export function unstick(w: CollisionWorld, box: Box, maxUp: number): number | null {
  const b = bounds(box)
  if (b === null) return null
  if (!boxSolid(w, b)) return 0
  if (!Number.isFinite(maxUp) || maxUp < 0) return null
  const top = w.size[1]
  for (let n = Math.floor(b[1]) + 1; n - b[1] <= maxUp && n <= top; n++) {
    const lift = n - b[1]
    if (!boxSolid(w, [b[0], n, b[2], b[3], b[4] + lift, b[5]])) return lift
  }
  return null
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/collision.test.ts`
Expected: PASS (36 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/interact/collision.ts packages/engine/test/collision.test.ts
git commit -m "feat(collision): unstick a box a block was edited into"
```

---

### Task 5: Liquid queries (`liquidAt`, `liquidInBox`)

**Files:**
- Modify: `packages/engine/src/interact/collision.ts` (append; add `voxelState` to the `../world/voxel.ts` import)
- Test: `packages/engine/test/collision.test.ts` (append; add `liquidAt, liquidInBox` to the import and `import { packVoxel } from '../src/world/voxel.ts'`)

**Interfaces:**
- Consumes: `bounds`, `firstCell`, `lastCell` (Task 1).
- Produces: `liquidAt(w, x, y, z): boolean`, `liquidInBox(w, box, eyeY?): LiquidInfo`; internal `fillOf(w, x, y, z): number`, `surfaceAt(w, x, z, y0, y1): number`.

- [ ] **Step 1: Write the failing tests**

```ts
const water = (level: number) => packVoxel(WATER, level)

describe('liquidAt', () => {
  it('is under the surface inside a liquid cell below its fill', () => {
    const { world, set } = makeWorld()
    set(10, 5, 10, water(7))   // full
    set(11, 5, 10, water(3))   // fill 0.5
    set(12, 5, 10, packVoxel(SPRING, 0)) // a spring counts as full
    set(13, 5, 10, STONE)
    expect(liquidAt(world, 10.5, 5.99, 10.5)).toBe(true)
    expect(liquidAt(world, 10.5, 6, 10.5)).toBe(false)
    expect(liquidAt(world, 11.5, 5.49, 10.5)).toBe(true)
    expect(liquidAt(world, 11.5, 5.5, 10.5)).toBe(false)
    expect(liquidAt(world, 12.5, 5.9, 10.5)).toBe(true)
    expect(liquidAt(world, 13.5, 5.5, 10.5)).toBe(false)
    expect(liquidAt(world, -0.5, 5.5, 10.5)).toBe(false)
    expect(liquidAt(world, 10.5, NaN, 10.5)).toBe(false)
  })
})

describe('liquidInBox', () => {
  it('measures a submerged body and finds the surface above it', () => {
    const { world, set } = makeWorld()
    set(10, 5, 10, water(7)); set(10, 6, 10, water(7)); set(10, 7, 10, water(3)) // surface at 7.5
    const r = liquidInBox(world, body(10.5, 5, 10.5), 6.6)
    expect(r.submerged).toBeCloseTo(1, 9)
    expect(r.surfaceY).toBeCloseTo(7.5, 9)
    expect(r.eyeUnder).toBe(true)
    expect(liquidInBox(world, body(10.5, 5, 10.5), 7.6).eyeUnder).toBe(false)
    expect(liquidInBox(world, body(10.5, 5, 10.5)).eyeUnder).toBe(false)
  })
  it('takes the max over the footprint columns and the surface from that column', () => {
    const { world, set } = makeWorld()
    set(10, 5, 10, water(7)) // column 10 wet to 6, column 11 dry
    const r = liquidInBox(world, body(11, 5, 10.5), 5.5)
    expect(r.submerged).toBeCloseTo(1 / 1.8, 9)
    expect(r.surfaceY).toBeCloseTo(6, 9)
    expect(r.eyeUnder).toBe(false) // the centre x = 11 is in the dry column
  })
  it('sees water under and over a bridge deck as separate runs', () => {
    const { world, set } = makeWorld()
    set(10, 5, 10, water(7)); set(10, 6, 10, STONE); set(10, 7, 10, water(7)); set(10, 8, 10, water(1))
    const under = liquidInBox(world, body(10.5, 5, 10.5))
    expect(under.submerged).toBeCloseTo(1 / 1.8, 9)
    expect(under.surfaceY).toBeCloseTo(6, 9)
    const over = liquidInBox(world, body(10.5, 7, 10.5))
    expect(over.submerged).toBeCloseTo(1.25 / 1.8, 9)
    expect(over.surfaceY).toBeCloseTo(8.25, 9)
  })
  it('is dry above a shallow partial cell, in air and outside the world', () => {
    const { world, set } = makeWorld()
    set(10, 5, 10, water(3)) // water to 5.5
    expect(liquidInBox(world, body(10.5, 5.6, 10.5))).toEqual({ submerged: 0, eyeUnder: false, surfaceY: null })
    expect(liquidInBox(world, body(20.5, 5, 20.5), 6)).toEqual({ submerged: 0, eyeUnder: false, surfaceY: null })
    expect(liquidInBox(world, body(-10, 5, -10), 6)).toEqual({ submerged: 0, eyeUnder: false, surfaceY: null })
    expect(liquidInBox(world, body(NaN, 5, 10.5), 6)).toEqual({ submerged: 0, eyeUnder: false, surfaceY: null })
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/collision.test.ts`
Expected: FAIL, because `liquidAt` and `liquidInBox` are not exported.

- [ ] **Step 3: Implement** (append; change the voxel import to `import { voxelId, voxelState } from '../world/voxel.ts'`)

```ts
/** The liquid fill of cell (x, y, z) from the voxel water mirror: 0 dry, 1 a spring, else (level + 1) / 8. */
function fillOf(w: CollisionWorld, x: number, y: number, z: number): number {
  const [sx, sy, sz] = w.size
  if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return 0
  const v = w.get(x, y, z), id = voxelId(v)
  if (w.liquid[id] !== 1) return 0
  return w.source[id] === 1 ? 1 : ((voxelState(v) & 7) + 1) / 8
}

/** Whether the point (x, y, z) is under a liquid surface: inside a liquid voxel, below that voxel's fill. */
export function liquidAt(w: CollisionWorld, x: number, y: number, z: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false
  const cy = Math.floor(y)
  const f = fillOf(w, Math.floor(x), cy, Math.floor(z))
  return f > 0 && y < cy + f
}

/** The top of the highest liquid run in column (x, z) that has a liquid cell in [y0, y1]: climbs through full cells. */
function surfaceAt(w: CollisionWorld, x: number, z: number, y0: number, y1: number): number {
  let y = y1
  while (y > y0 && fillOf(w, x, y, z) === 0) y--
  let f = fillOf(w, x, y, z)
  while (f === 1) {
    const g = fillOf(w, x, y + 1, z)
    if (g === 0) break
    y++
    f = g
  }
  return y + f
}

export function liquidInBox(w: CollisionWorld, box: Box, eyeY?: number): LiquidInfo {
  const r: LiquidInfo = { submerged: 0, eyeUnder: false, surfaceY: null }
  const b = bounds(box)
  if (b === null) return r
  const [sx, sy, sz] = w.size
  const x0 = Math.max(0, firstCell(b[0])), x1 = Math.min(sx - 1, lastCell(b[0], b[3]))
  const z0 = Math.max(0, firstCell(b[2])), z1 = Math.min(sz - 1, lastCell(b[2], b[5]))
  const y0 = Math.max(0, firstCell(b[1])), y1 = Math.min(sy - 1, lastCell(b[1], b[4]))
  let best = 0, bx = 0, bz = 0
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
    let wet = 0
    for (let y = y0; y <= y1; y++) {
      const f = fillOf(w, x, y, z)
      if (f > 0) wet += Math.max(0, Math.min(y + f, b[4]) - Math.max(y, b[1]))
    }
    if (wet > best) { best = wet; bx = x; bz = z }
  }
  const height = b[4] - b[1]
  if (best > 0) {
    r.submerged = height > 0 ? Math.min(1, best / height) : 0
    r.surfaceY = surfaceAt(w, bx, bz, y0, y1)
  }
  if (eyeY !== undefined) r.eyeUnder = liquidAt(w, (b[0] + b[3]) / 2, eyeY, (b[2] + b[5]) / 2)
  return r
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/collision.test.ts`
Expected: PASS (41 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/interact/collision.ts packages/engine/test/collision.test.ts
git commit -m "feat(collision): liquid queries from the voxel water mirror"
```

---

### Task 6: Binding, `engine.collision` and exports

**Files:**
- Modify: `packages/engine/src/interact/collision.ts` (append)
- Modify: `packages/engine/src/engine.ts` (an import line after line 7; the `Engine` member after line 122 `readonly world`; the binding before `const pickable` near line 563; `collision,` after `raycast: rc,` near line 623)
- Modify: `packages/engine/src/index.ts` (append one line)
- Test: `packages/engine/test/collision.test.ts` (append; add `bindCollision` to the import, plus `import { ghostAwareGet } from '../src/engineWorld.ts'`, `import { GhostEdits } from '../src/interact/ghostEdits.ts'`, `import { Layout } from '../src/world/layout.ts'`)

**Interfaces:**
- Consumes: every function above.
- Produces: `bindCollision(w): Collision`; `Engine.collision: Collision`; package exports.

- [ ] **Step 1: Write the failing tests**

```ts
describe('bindCollision', () => {
  it('collides with ghost edits through the ghost-aware getter', () => {
    const { world, set } = makeWorld()
    set(8, 10, 10, STONE)
    const ghosts = new GhostEdits(new Layout(world.size))
    const c = bindCollision({ ...world, get: ghostAwareGet(ghosts, world.get) })
    const b = body(10.5, 10, 10.5)
    expect(c.move(b, [3, 0, 0]).dx).toBe(3)
    ghosts.add(1, 12, 10, 10, STONE) // predicted, not acked
    expect(10.8 + c.move(b, [3, 0, 0]).dx).toBeCloseTo(12, 9)
    expect(c.overlaps(body(12.5, 10, 10.5))).toBe(true)
    ghosts.add(2, 8, 10, 10, 0) // a predicted removal of real stone
    expect(c.sweep(b, [-3, 0, 0]).dx).toBe(-3)
    ghosts.resolve(1)
    expect(c.move(b, [3, 0, 0]).dx).toBe(3)
  })
  it('forwards every query', () => {
    const { world, set } = floored()
    set(10, 5, 10, STONE); set(20, 5, 20, water(7))
    const c = bindCollision(world)
    expect(c.groundDistance(body(15.5, 5.5, 15.5), 1)).toBeCloseTo(0.5, 9)
    expect(c.unstick(body(10.5, 5, 10.5), 1)).toBe(1)
    expect(c.liquid(body(20.5, 5, 20.5), 5.5)).toMatchObject({ eyeUnder: true, surfaceY: 6 })
    expect(c.liquidAt(20.5, 5.5, 20.5)).toBe(true)
    expect(c.move(body(15.5, 5, 15.5), [0, -1, 0], { stepHeight: 1 }).grounded).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/collision.test.ts`
Expected: FAIL, because `bindCollision` is not exported.

- [ ] **Step 3: Implement**

Append to `collision.ts`:

```ts
/** The functions closed over one world: what `engine.collision` is. */
export function bindCollision(w: CollisionWorld): Collision {
  return {
    sweep: (box, delta, out) => sweepBox(w, box, delta, out),
    move: (box, delta, options, out) => moveBox(w, box, delta, options, out),
    overlaps: box => boxOverlapsSolid(w, box),
    groundDistance: (box, maxDown) => groundDistance(w, box, maxDown),
    liquid: (box, eyeY) => liquidInBox(w, box, eyeY),
    liquidAt: (x, y, z) => liquidAt(w, x, y, z),
    unstick: (box, maxUp) => unstick(w, box, maxUp),
  }
}
```

`engine.ts`, four additive hunks:

```ts
// after: import { raycast, type RayHit, type Vec3Like } from './interact/raycast.ts'
import { bindCollision, type Collision } from './interact/collision.ts'
```

```ts
// in interface Engine, after: readonly world: { get(...): number; getLight(...): number }
  /** AABB-vs-voxel collision over the ghost-aware world (a predicted edit collides at once). Pure geometry: no dt or gravity. */
  readonly collision: Collision
```

```ts
// before: const pickable = (v: number) => { ... }
  const collision = bindCollision({ size, get: world.get, solid: registry.solid, liquid: registry.liquid, source: registry.source })
```

```ts
// in the returned engine object, after: raycast: rc,
    collision,
```

`index.ts`, appended as the last line:

```ts
export { CONTACT_EPS, GROUND_EPS, bindCollision, bodyBox, boxOverlapsSolid, groundDistance, liquidAt, liquidInBox, moveBox, sweepBox, unstick, type Box, type Collision, type CollisionWorld, type LiquidInfo, type MoveOptions, type MoveResult, type SweepResult } from './interact/collision.ts'
```

- [ ] **Step 4: Run to verify they pass, and typecheck the engine package**

Run: `npx vitest run test/collision.test.ts`
Expected: PASS (43 tests).
Run: `npx tsc --noEmit -p .` (the engine package only; allowed under HOLD only if the expert agrees, otherwise defer to Task 7)
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/interact/collision.ts packages/engine/src/engine.ts packages/engine/src/index.ts packages/engine/test/collision.test.ts
git commit -m "feat(collision): engine.collision bound to the ghost-aware world"
```

---

### Task 7: Full verification and hand-off

Only after the expert's RELEASE.

- [ ] **Step 1: Engine unit suite**

Run (from `packages/engine`): `npx vitest run > %SCRATCH%/engine-tests.log 2>&1`, then read the log.
Expected: every file passes, including `collision.test.ts`; the previous test count + 43.

- [ ] **Step 2: Repo typecheck**

Run (from the repo root of the worktree): `npm run typecheck > %SCRATCH%/typecheck.log 2>&1`, then read the log.
Expected: exit 0 in every workspace.

- [ ] **Step 3: Write `docs/superpowers/reviews/2026-10-08-collision.md`**

Contents: the branch and HEAD; spec and plan paths; the API delivered against spec §3 (tick each function); the test count and typecheck result with the commands; the limitations from spec §8; open items.

```bash
git add docs/superpowers/reviews/2026-10-08-collision.md
git commit -m "docs(4c): collision review"
```

- [ ] **Step 4: Notify**

SendMessage the expert and fpcontrol: "API final and tested at <SHA of the Task 6 commit>; HEAD <SHA>".
