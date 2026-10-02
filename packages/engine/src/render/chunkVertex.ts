import { attribute, bool, float, select, uint, varying, vec2, vec3 } from 'three/tsl'
import { AO_CURVE } from '../mesh/ao.ts'
import { FLIP_U } from './faceUv.ts'

/** TSL nodes decoded from the packed 8-byte chunk vertex (sub-project 1 format; spec §5 of the core spec). */
export function chunkVertex() {
  const packed = attribute('packed', 'uvec2')
  const a = packed.x, b = packed.y
  const px = a.bitAnd(uint(63)).toFloat()
  const py = a.shiftRight(uint(6)).bitAnd(uint(63)).toFloat()
  const pz = a.shiftRight(uint(12)).bitAnd(uint(63)).toFloat()
  const nIdx = a.shiftRight(uint(18)).bitAnd(uint(7))
  const ao = a.shiftRight(uint(21)).bitAnd(uint(3))
  const drop = a.shiftRight(uint(25)).bitAnd(uint(31)).toFloat()
  const layer = b.bitAnd(uint(4095)).toFloat()
  const sky = b.shiftRight(uint(12)).bitAnd(uint(15)).toFloat().div(15)
  const blk = b.shiftRight(uint(16)).bitAnd(uint(15)).toFloat().div(15)

  const local = vec3(px, py.sub(drop.div(16)), pz)
  const normal = select(nIdx.equal(uint(0)), vec3(1, 0, 0),
    select(nIdx.equal(uint(1)), vec3(-1, 0, 0),
      select(nIdx.equal(uint(2)), vec3(0, 1, 0),
        select(nIdx.equal(uint(3)), vec3(0, -1, 0),
          select(nIdx.equal(uint(4)), vec3(0, 0, 1), vec3(0, 0, -1))))))
  const axis = nIdx.shiftRight(uint(1))
  const uvRaw = select(axis.equal(uint(0)), vec2(local.z, local.y), select(axis.equal(uint(1)), vec2(local.x, local.z), vec2(local.x, local.y)))
  const flip = FLIP_U.reduce<ReturnType<typeof nIdx.equal>>((acc, on, f) => (on ? acc.or(nIdx.equal(uint(f))) : acc), bool(false) as unknown as ReturnType<typeof nIdx.equal>)
  const uv = vec2(select(flip, uvRaw.x.negate(), uvRaw.x), uvRaw.y)
  const aoF = select(ao.equal(uint(0)), float(AO_CURVE[0]!),
    select(ao.equal(uint(1)), float(AO_CURVE[1]!), select(ao.equal(uint(2)), float(AO_CURVE[2]!), float(AO_CURVE[3]!))))

  return {
    position: local.sub(16),
    normal: varying(normal),
    uv: varying(uv),
    layer: varying(layer),
    sky: varying(sky),
    blk: varying(blk),
    ao: varying(aoF),
  }
}

export type ChunkVertex = ReturnType<typeof chunkVertex>
