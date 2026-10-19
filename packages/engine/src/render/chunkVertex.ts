import { attribute, bool, drawIndex, float, Fn, instanceIndex, int, ivec2, modelWorldMatrix, select, textureLoad, textureSize, uint, varying, vec2, vec3, vec4 } from 'three/tsl'
import type * as THREE from 'three/webgpu'
import { AO_CURVE } from '../mesh/ao.ts'
import { LIQUID_DEEP } from '../mesh/vertexFormat.ts'
import { FLIP_U } from './faceUv.ts'

/** A data texture's width in texels (level 0), as an int node. */
const widthOf = (t: THREE.DataTexture) => int((textureSize(textureLoad(t), int(0)) as unknown as ReturnType<typeof ivec2>).x)

/**
 * The chunk's translation when a BatchedMesh draws it (chunkBatches.ts), else 0. Trap 1 of chunkBatches.ts: three r186
 * applies the batch's per-instance matrix to positionLocal BEFORE the material's positionNode, which then overwrites
 * it, so a custom positionNode must read that matrix itself: the draw's index -> the batch's indirect texture -> the
 * instance's matrix in the matrices texture (4 texels per matrix) -> column 3. The draw's index is backend-specific, as
 * in three's own nodes/accessors/Batch.js: WebGPU draws each range with firstInstance = its index, so instance_index;
 * WebGL 2 has no firstInstance (gl_InstanceID is 0) and exposes gl_DrawID (or a per-draw uniform) as `drawIndex`.
 */
const batchOffset = Fn((_: unknown, builder: { object?: THREE.Object3D }) => {
  const bm = builder.object as (THREE.BatchedMesh & { _indirectTexture: THREE.DataTexture; _matricesTexture: THREE.DataTexture }) | undefined
  if (!bm || bm.isBatchedMesh !== true) return vec3(0, 0, 0)
  const ind = bm._indirectTexture, mat = bm._matricesTexture
  const isize = widthOf(ind).toConst()
  const drawIndexBuiltin = (builder as unknown as { getDrawIndex(): string | null }).getDrawIndex()
  const id = int(drawIndexBuiltin === null ? instanceIndex : drawIndex).toConst()
  const indirect = int(textureLoad(ind, ivec2(id.mod(isize), id.div(isize))).x).toConst()
  const msize = widthOf(mat).toConst()
  const j = indirect.mul(4).toConst()
  return textureLoad(mat, ivec2(j.mod(msize).add(3), j.div(msize))).xyz
})

/** Loose TSL node type for the optional per-layer scale table (a `uniformArray` of floats). */
type ScaleTable = { element(i: unknown): ReturnType<typeof float> }

/**
 * TSL nodes decoded from the packed 8-byte chunk vertex (sub-project 1 format; spec §5 of the core spec).
 * `scales`, when given, holds one entry per texture-array layer: how many blocks one repeat of that texture spans.
 */
export function chunkVertex(scales?: ScaleTable, liquid = false) {
  const packed = attribute('packed', 'uvec2')
  const a = packed.x, b = packed.y
  const px = a.bitAnd(uint(63)).toFloat()
  const py = a.shiftRight(uint(6)).bitAnd(uint(63)).toFloat()
  const pz = a.shiftRight(uint(12)).bitAnd(uint(63)).toFloat()
  const nIdx = a.shiftRight(uint(18)).bitAnd(uint(7))
  const ao = a.shiftRight(uint(21)).bitAnd(uint(3))
  const drop = a.shiftRight(uint(25)).bitAnd(uint(31)).toFloat()
  /** 1 on a top face created by the layer cut (vertexFormat.ts CUT_BIT), else 0. */
  const cut = a.shiftRight(uint(30)).bitAnd(uint(1)).toFloat()
  const layerBits = b.bitAnd(uint(4095))
  const layer = layerBits.toFloat()
  const sky = b.shiftRight(uint(12)).bitAnd(uint(15)).toFloat().div(15)
  const blk = b.shiftRight(uint(16)).bitAnd(uint(15)).toFloat().div(15)
  // A shaped block's corner between grid points, in sixteenths (vertexFormat.ts word B); 0 for every other vertex.
  const fx = b.shiftRight(uint(20)).bitAnd(uint(15)).toFloat().div(16)
  const fy = b.shiftRight(uint(24)).bitAnd(uint(15)).toFloat().div(16)
  const fz = b.shiftRight(uint(28)).bitAnd(uint(15)).toFloat().div(16)

  const local = vec3(px.add(fx), py.add(fy).sub(drop.div(16)), pz.add(fz))
  // Chunk-centred; a batched chunk adds its translation here (an unbatched mesh's model matrix carries it instead).
  const position = local.sub(16).add(batchOffset())
  const normal = select(nIdx.equal(uint(0)), vec3(1, 0, 0),
    select(nIdx.equal(uint(1)), vec3(-1, 0, 0),
      select(nIdx.equal(uint(2)), vec3(0, 1, 0),
        select(nIdx.equal(uint(3)), vec3(0, -1, 0),
          select(nIdx.equal(uint(4)), vec3(0, 0, 1), vec3(0, 0, -1))))))
  const axis = nIdx.shiftRight(uint(1))
  // Project the WORLD position, not the chunk-local one: chunk origins are multiples of 32, so this is identical at
  // scale 1, and a non-integer texture scale stays continuous across chunk borders.
  const world = modelWorldMatrix.mul(vec4(position, 1)).xyz
  const proj = select(axis.equal(uint(0)), vec2(world.z, world.y), select(axis.equal(uint(1)), vec2(world.x, world.z), vec2(world.x, world.y)))
  const uvRaw = scales ? proj.div(scales.element(layerBits.toInt())) : proj
  const flip = FLIP_U.reduce<ReturnType<typeof nIdx.equal>>((acc, on, f) => (on ? acc.or(nIdx.equal(uint(f))) : acc), bool(false) as unknown as ReturnType<typeof nIdx.equal>)
  const uv = vec2(select(flip, uvRaw.x.negate(), uvRaw.x), uvRaw.y)
  const aoF = select(ao.equal(uint(0)), float(AO_CURVE[0]!),
    select(ao.equal(uint(1)), float(AO_CURVE[1]!), select(ao.equal(uint(2)), float(AO_CURVE[2]!), float(AO_CURVE[3]!))))

  return {
    position,
    normal: varying(normal),
    uv: varying(uv),
    layer: varying(layer),
    sky: varying(sky),
    blk: varying(blk),
    // Liquid vertices carry flags in their ao bits (LIQUID_DEEP), not occlusion: their AO is always 1.
    ao: liquid ? float(1) : varying(aoF),
    cut: liquid ? float(0) : varying(cut),
    /**
     * The vertex's surface height within its cell (1 = full); 1 for deep water (a LIQUID_DEEP vertex: the same liquid
     * lies below, so a thin top layer still reads as deep) and for non-liquid layers.
     */
    surface: liquid ? varying(select(ao.equal(uint(LIQUID_DEEP)), float(1), float(1).sub(drop.div(16)))) : float(1),
  }
}

export type ChunkVertex = ReturnType<typeof chunkVertex>
