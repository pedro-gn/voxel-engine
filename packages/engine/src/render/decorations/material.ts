import * as THREE from 'three/webgpu'
import {
  attribute, cameraPosition, float, floor, fract, hash, mix, modelWorldMatrix, mx_noise_float, select, sin, smoothstep,
  time, uint, uniform, uniformArray, varying, vec2, vec3, vec4,
} from 'three/tsl'
import type { LightUniforms } from '../voxelLighting.ts'
import { VoxelNodeMaterial, voxelLit } from '../voxelLighting.ts'
import { MAX_DECORATIONS, MAX_FLOWER_COLORS, grassStyle, type DecorationRegistry } from './defs.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any // TSL node typings are too narrow for swizzles and uniform-array elements

function instance() {
  const inst = attribute('inst', 'uvec2')
  const a = inst.x, b = inst.y
  const cell = vec3(a.bitAnd(uint(31)).toFloat(), a.shiftRight(uint(5)).bitAnd(uint(31)).toFloat().add(1), a.shiftRight(uint(10)).bitAnd(uint(31)).toFloat())
  const world = modelWorldMatrix.mul(vec4(cell, 1)).xyz
  return {
    cell, world,
    edge: a.shiftRight(uint(15)).bitAnd(uint(15)),
    sky: varying(a.shiftRight(uint(19)).bitAnd(uint(15)).toFloat().div(15)),
    blk: varying(a.shiftRight(uint(23)).bitAnd(uint(15)).toFloat().div(15)),
    deco: b.bitAnd(uint(255)).toInt(),
    color: b.shiftRight(uint(8)).bitAnd(uint(7)).toInt(),
    rnd: hash(world.x.mul(73.1).add(world.z.mul(19.7)).add(world.y.mul(7.3))),
  }
}

const v4 = (c: readonly number[], w = 1) => new THREE.Vector4(c[0], c[1], c[2], w)

export function createDecorationMaterials(reg: DecorationRegistry, lights: LightUniforms) {
  const radius = uniform(96)
  const pad = <T>(xs: T[], n: number, fill: T) => [...xs, ...new Array<T>(Math.max(0, n - xs.length)).fill(fill)]
  const params = uniformArray(pad(reg.defs.map((d) => new THREE.Vector4(d.grass?.blades ?? 0, d.grass?.height[0] ?? 0, d.grass?.height[1] ?? 0, d.grass?.overhang ?? 0)), MAX_DECORATIONS, new THREE.Vector4()), 'vec4')
  // The soft-grass style beside params: shape (width, jitter, blunt, rootShade), cover (1 / scale, threshold, soft, clump).
  const styles = reg.defs.map((d) => grassStyle(d.grass))
  const shapes = uniformArray(pad(styles.map((s) => new THREE.Vector4(...s.shape)), MAX_DECORATIONS, new THREE.Vector4(1, 0.3, 0, 0.45)), 'vec4')
  const covers = uniformArray(pad(styles.map((s) => new THREE.Vector4(...s.cover)), MAX_DECORATIONS, new THREE.Vector4(0, -1, 0.5, 1)), 'vec4')
  const bases = uniformArray(pad(reg.defs.map((d) => v4(d.grass?.base ?? [0, 0, 0])), MAX_DECORATIONS, new THREE.Vector4()), 'vec4')
  const tips = uniformArray(pad(reg.defs.map((d) => v4(d.grass?.tip ?? [0, 0, 0])), MAX_DECORATIONS, new THREE.Vector4()), 'vec4')
  const petals = uniformArray(reg.defs.flatMap((d) => pad((d.flowers?.colors ?? []).map((c) => v4(c)), MAX_FLOWER_COLORS, new THREE.Vector4()))
    .concat(new Array(Math.max(0, (MAX_DECORATIONS - reg.defs.length) * MAX_FLOWER_COLORS)).fill(new THREE.Vector4())), 'vec4')
  const fadeAt = (world: N) => float(1).sub(smoothstep(radius.mul(0.6), radius, world.xz.add(0.5).sub(cameraPosition.xz).length()))
  const wind = (world: N, rnd: N): N => mx_noise_float(vec3(world.xz.mul(0.07).add(time.mul(0.5)), time.mul(0.15))).mul(0.18)
    .add(sin(time.mul(2.1).add(rnd.mul(6.283))).mul(0.04))

  // ---- grass ----
  const gi = instance()
  const vBase: N = varying((bases.element(gi.deco) as N).xyz), vTip: N = varying((tips.element(gi.deco) as N).xyz)
  const pos = attribute('position', 'vec3'), info = attribute('info', 'vec4')
  const P: N = params.element(gi.deco), S: N = shapes.element(gi.deco), C: N = covers.element(gi.deco)
  const k = floor(gi.rnd.mul(8))
  const swap = k.mod(2).greaterThan(0.5), mirX = floor(k.div(2)).mod(2).greaterThan(0.5), mirZ = k.greaterThanEqual(4)
  const sx = select(swap, info.w, info.z), sz = select(swap, info.z, info.w)
  const rx: N = select(mirX, float(1).sub(sx), sx), rz: N = select(mirZ, float(1).sub(sz), sz)
  const t: N = pos.y
  const fade = fadeAt(gi.world)
  // Per-tile density: a low-frequency patch value (vertex stage, from the instance's world cell) blended with a per-instance random.
  const clump = smoothstep(0.25, 0.75, mx_noise_float(vec3(gi.world.xz.mul(0.09), 0)).mul(0.5).add(0.5))
  const density = clump.mul(0.65).add(gi.rnd.mul(0.35))
  // Coverage: bare tops where a world-space low-frequency noise falls below the threshold; tufts thin and shorten across ± soft.
  const coverAt: N = vec3((gi.world.xz as N).mul(C.x), 3.7)
  const cover = smoothstep(C.y.sub(C.z), C.y.add(C.z), mx_noise_float(coverAt).mul(0.5).add(0.5))
  // Blade shape: the width multiplier, and a blunt tip that widens and raises the mid section (t is 0, 0.5 or 1 per vertex).
  const mid = float(1).sub(t.mul(2).sub(1).abs())
  const spread = S.x.mul(S.z.mul(0.5).mul(mid).add(1))
  const tShape: N = t.add(S.z.mul(0.15).mul(mid))
  const height: N = mix(P.y, P.z, info.y).mul(fade).mul(gi.rnd.mul(0.3).add(0.85)).mul(mix(float(1), mix(float(0.75), float(1.1), density), C.w)).mul(mix(float(0.5), float(1), cover))
  const bit = (m: number) => select(gi.edge.bitAnd(uint(m)).notEqual(uint(0)), float(1), float(0))
  const leanX = bit(1).mul(smoothstep(0.55, 1, rx)).sub(bit(2).mul(smoothstep(0.55, 1, float(1).sub(rx))))
  const leanZ = bit(4).mul(smoothstep(0.55, 1, rz)).sub(bit(8).mul(smoothstep(0.55, 1, float(1).sub(rz))))
  const t2 = t.mul(t)
  const over = P.w.mul(fade)
  const sway = wind(gi.world, gi.rnd)
  const local = vec3(
    rx.add(pos.x.sub(info.z).mul(spread)).add(leanX.mul(over).mul(1.6).add(sway).mul(t2)),
    tShape.mul(height).sub(vec2(leanX, leanZ).length().mul(over).mul(0.5).mul(t2)),
    rz.add(pos.z.sub(info.w).mul(spread)).add(leanZ.mul(over).mul(1.6).add(sway.mul(0.6)).mul(t2)),
  )
  const grass = new VoxelNodeMaterial(gi.sky)
  grass.positionNode = select(info.x.lessThan(P.x.mul(mix(float(1), mix(float(0.3), float(1), density), C.w)).mul(cover)), gi.cell.add(local), gi.cell.add(vec3(0.5, 0, 0.5)))
  const vt: N = varying(t), vr: N = varying(gi.rnd), vS: N = varying(S)
  const gAlbedo: N = mix(vBase, vTip, vt.pow(1.2)).mul(vr.mul(vS.y).add(float(1).sub(vS.y.mul(0.5))))
  grass.colorNode = vec4(gAlbedo, 1)
  grass.side = THREE.DoubleSide
  voxelLit(grass, { normal: vec3(0, 1, 0), sky: gi.sky, blk: gi.blk, ao: mix(float(1).sub(vS.w), float(1), vt), albedo: gAlbedo }, lights)

  // ---- flowers ----
  const fi = instance()
  const fpos = attribute('position', 'vec3'), finfo = attribute('info', 'vec4')
  const ffade = fadeAt(fi.world)
  const scale = ffade.mul(fi.rnd.mul(0.4).add(0.8))
  const ft = finfo.y
  const fsway = wind(fi.world, fi.rnd).mul(ft.mul(ft))
  const ox = fi.rnd.mul(0.6).add(0.2), oz = fract(fi.rnd.mul(13.7)).mul(0.6).add(0.2)
  const flowers = new VoxelNodeMaterial(fi.sky)
  flowers.positionNode = fi.cell.add(vec3(ox.add(fpos.x.mul(scale)).add(fsway), fpos.y.mul(scale), oz.add(fpos.z.mul(scale)).add(fsway.mul(0.6))))
  const petal: N = varying((petals.element(fi.deco.mul(MAX_FLOWER_COLORS).add(fi.color)) as N).xyz)
  const fAlbedo = select(varying(finfo.x).lessThan(0.5), vec3(0.16, 0.36, 0.09), petal)
  flowers.colorNode = vec4(fAlbedo, 1)
  flowers.side = THREE.DoubleSide
  voxelLit(flowers, { normal: vec3(0, 1, 0), sky: fi.sky, blk: fi.blk, ao: float(1), albedo: fAlbedo }, lights)

  return { grass, flowers, radius }
}
