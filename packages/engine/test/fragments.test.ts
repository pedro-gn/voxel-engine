import { expect, it } from 'vitest'
import { BlockRegistry } from '../src/blocks/registry.ts'
import { fragmentGeometry } from '../src/render/fragmentGeometry.ts'
import { FragmentTrack } from '../src/render/fragmentTrack.ts'
import { SimClock } from '../src/render/simClock.ts'
import { Layout } from '../src/world/layout.ts'
import type { FragmentBirth } from '../src/sim/collapse.ts'

const layout = new Layout([64, 32, 32])
const birth: FragmentBirth = { id: 1, positions: Uint32Array.of(layout.voxelIndex(31, 10, 10), layout.voxelIndex(32, 10, 10)), voxels: Uint16Array.of(1, 1), source: [{ chunk: 0, version: 4 }, { chunk: 1, version: 8 }] }
it('meshes exposed faces once with correct winding, texture layers and normals', () => {
  const registry = new BlockRegistry([{ name: 'beam', collapses: true }])
  const data = fragmentGeometry(birth, layout, registry, new Uint16Array(12).fill(7), () => 15)[0]
  expect(data.indices.length).toBe(10 * 6)
  for (let i = 0; i < data.indices.length; i += 3) {
    const ia = data.indices[i]!, ib = data.indices[i + 1]!, ic = data.indices[i + 2]!
    const a = [0, 1, 2].map(k => data.positions[ib * 3 + k] - data.positions[ia * 3 + k])
    const b = [0, 1, 2].map(k => data.positions[ic * 3 + k] - data.positions[ia * 3 + k])
    const cross = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
    expect(cross.reduce((v, n, k) => v + n * data.normals[ia * 3 + k], 0)).toBeGreaterThan(0)
    expect(data.info[ia * 3]).toBe(7)
    expect(data.info[ia * 3 + 1]).toBe(15)
  }
})
it('preserves translucent and cutout materials while culling equal internal glass faces', () => {
  const registry = new BlockRegistry([{ name: 'glass', collapses: true, layer: 'translucent' }, { name: 'leaves', collapses: true, layer: 'cutout' }])
  const glass = fragmentGeometry(birth, layout, registry, new Uint16Array(18), () => 15)
  expect(glass[0].layer).toBe(3); expect(glass[0].indices.length).toBe(60)
  const mixed = fragmentGeometry({ ...birth, voxels: Uint16Array.of(1, 2) }, layout, registry, new Uint16Array(18), () => 15)
  expect(mixed.map(d => d.layer)).toEqual([3, 2])
})
it('holds the source until every spanning chunk is ready and retains debris through the complete landing handoff', () => {
  const clock = new SimClock(50), track = new FragmentTrack(clock)
  track.update(0, { born: [birth], poses: Int32Array.of(1, 0, 0), landed: [] }, 0)
  expect(track.holdsChunk(0)).toBe(true)
  expect(track.sourcesReady(ci => ci === 0 ? 4 : 6)).toBe(false)
  expect(track.frame(50, () => 100)).toEqual([])
  expect(track.sourcesReady(ci => ci === 0 ? 4 : 8)).toBe(true)
  track.releaseSources()
  expect(track.frame(50, () => 8)).toHaveLength(1)
  track.update(1, { born: [], poses: Int32Array.of(1, -24, 24), landed: [] }, 50)
  track.update(2, { born: [], poses: new Int32Array(), landed: [{ id: 1, offset256: -256, chunks: [{ chunk: 0, version: 10 }, { chunk: 1, version: 12 }] }] }, 100)
  for (let now = 150; now < 600; now += 50) expect(track.frame(now, ci => ci === 0 ? 10 : 10)).toHaveLength(1)
  for (let now = 600; now < 1100; now += 50) track.frame(now, () => 12)
  expect(track.size).toBe(0)
})
