import { attribute, bool, clamp, float, mix, modelWorldMatrix, select, uint, uniform, varying, vec2, vec3, vec4 } from 'three/tsl'
import { AO_CURVE } from '../mesh/ao.ts'
import { LIQUID_DEEP } from '../mesh/vertexFormat.ts'
import { FLIP_U } from './faceUv.ts'
import { BLEND_SECONDS } from './liquidBlend.ts'

/** The liquid blend clock (ChunkMeshes.now(), seconds), set every frame; liquid heights glide toward their remeshed value. */
export const liquidNow = uniform(0)

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
  const target = a.shiftRight(uint(25)).bitAnd(uint(31)).toFloat()
  // Liquid geometries carry the blend start per vertex (liquidBlend.ts); other layers have no such attributes.
  const drop = liquid
    ? mix(attribute('prevDrop', 'float'), target, clamp(liquidNow.sub(attribute('t0', 'float')).div(BLEND_SECONDS), 0, 1))
    : target
  // Liquid faces keep flow bits in word B bits 9-11 (and word A bits 30-31), so their layer is 9 bits wide.
  const layerBits = b.bitAnd(uint(liquid ? 511 : 4095))
  const layer = layerBits.toFloat()
  const sky = b.shiftRight(uint(12)).bitAnd(uint(15)).toFloat().div(15)
  const blk = b.shiftRight(uint(16)).bitAnd(uint(15)).toFloat().div(15)

  const local = vec3(px, py.sub(drop.div(16)), pz)
  const normal = select(nIdx.equal(uint(0)), vec3(1, 0, 0),
    select(nIdx.equal(uint(1)), vec3(-1, 0, 0),
      select(nIdx.equal(uint(2)), vec3(0, 1, 0),
        select(nIdx.equal(uint(3)), vec3(0, -1, 0),
          select(nIdx.equal(uint(4)), vec3(0, 0, 1), vec3(0, 0, -1))))))
  const axis = nIdx.shiftRight(uint(1))
  // Project the WORLD position, not the chunk-local one: chunk origins are multiples of 32, so this is identical at
  // scale 1, and a non-integer texture scale stays continuous across chunk borders.
  const world = modelWorldMatrix.mul(vec4(local.sub(16), 1)).xyz
  const proj = select(axis.equal(uint(0)), vec2(world.z, world.y), select(axis.equal(uint(1)), vec2(world.x, world.z), vec2(world.x, world.y)))
  const uvRaw = scales ? proj.div(scales.element(layerBits.toInt())) : proj
  const flip = FLIP_U.reduce<ReturnType<typeof nIdx.equal>>((acc, on, f) => (on ? acc.or(nIdx.equal(uint(f))) : acc), bool(false) as unknown as ReturnType<typeof nIdx.equal>)
  const uv = vec2(select(flip, uvRaw.x.negate(), uvRaw.x), uvRaw.y)
  const aoF = select(ao.equal(uint(0)), float(AO_CURVE[0]!),
    select(ao.equal(uint(1)), float(AO_CURVE[1]!), select(ao.equal(uint(2)), float(AO_CURVE[2]!), float(AO_CURVE[3]!))))

  const code = liquid
    ? a.shiftRight(uint(30)).bitAnd(uint(3)).bitOr(b.shiftRight(uint(9)).bitAnd(uint(7)).shiftLeft(uint(2)))
    : uint(0)
  const moving = code.shiftRight(uint(4)).bitAnd(uint(1)).toFloat()
  const steep = code.shiftRight(uint(3)).bitAnd(uint(1)).toFloat()
  const angle = code.bitAnd(uint(7)).toFloat().mul(Math.PI / 4)
  // x, z: unit direction (0 when still); z component of the vec3: speed (1 gentle, 2.5 steep, 0 still)
  const flow = vec3(angle.cos().mul(moving), angle.sin().mul(moving), moving.mul(steep.mul(1.5).add(1)))

  return {
    position: local.sub(16),
    normal: varying(normal),
    uv: varying(uv),
    layer: varying(layer),
    sky: varying(sky),
    blk: varying(blk),
    // Liquid vertices carry flags in their ao bits (LIQUID_DEEP), not occlusion: their AO is always 1.
    ao: liquid ? float(1) : varying(aoF),
    flow: varying(flow),
    /**
     * The vertex's surface height within its cell (1 = full); 1 for deep water (a LIQUID_DEEP vertex: the same liquid
     * lies below, so a thin top layer still reads as deep) and for non-liquid layers.
     */
    surface: liquid ? varying(select(ao.equal(uint(LIQUID_DEEP)), float(1), float(1).sub(drop.div(16)))) : float(1),
  }
}

export type ChunkVertex = ReturnType<typeof chunkVertex>
