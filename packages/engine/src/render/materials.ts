import * as THREE from 'three/webgpu'
import { attribute, dot, float, max, mix, select, texture, uint, uniform, varying, vec2, vec3, vec4 } from 'three/tsl'
import { AO_CURVE } from '../mesh/ao.ts'

export interface ChunkMaterials {
  opaque: THREE.MeshBasicNodeMaterial
  cutout: THREE.MeshBasicNodeMaterial
  translucent: THREE.MeshBasicNodeMaterial
  lighting: { sunDir: THREE.Vector3; sunColor: THREE.Color; skyColor: THREE.Color; groundColor: THREE.Color; ambient: { value: number } }
}

export function createChunkMaterials(tex: THREE.DataArrayTexture): ChunkMaterials {
  const sunDir = new THREE.Vector3(0.45, 0.85, 0.3).normalize()
  const sunColor = new THREE.Color(1.0, 0.96, 0.88)
  const skyColor = new THREE.Color(0.66, 0.76, 0.9)
  const groundColor = new THREE.Color(0.42, 0.37, 0.32)
  const ambient = uniform(0.6)
  const uSun = uniform(sunDir), uSunColor = uniform(sunColor), uSky = uniform(skyColor), uGround = uniform(groundColor)

  function build(mode: 'opaque' | 'cutout' | 'translucent'): THREE.MeshBasicNodeMaterial {
    const m = new THREE.MeshBasicNodeMaterial()
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
    m.positionNode = local.sub(16)

    const normal = select(nIdx.equal(uint(0)), vec3(1, 0, 0),
      select(nIdx.equal(uint(1)), vec3(-1, 0, 0),
        select(nIdx.equal(uint(2)), vec3(0, 1, 0),
          select(nIdx.equal(uint(3)), vec3(0, -1, 0),
            select(nIdx.equal(uint(4)), vec3(0, 0, 1), vec3(0, 0, -1))))))
    const axis = nIdx.shiftRight(uint(1))
    const uv = select(axis.equal(uint(0)), vec2(local.z, local.y), select(axis.equal(uint(1)), vec2(local.x, local.z), vec2(local.x, local.y)))
    const aoF = select(ao.equal(uint(0)), float(AO_CURVE[0]!),
      select(ao.equal(uint(1)), float(AO_CURVE[1]!), select(ao.equal(uint(2)), float(AO_CURVE[2]!), float(AO_CURVE[3]!))))

    const vUv = varying(uv)
    const vLayer = varying(layer)
    const vNormal = varying(normal)
    const vLight = varying(vec2(sky, blk))
    const vAO = varying(aoF)

    const albedo = texture(tex, vUv).depth(vLayer.add(0.5).toInt())
    const ndl = max(dot(vNormal, uSun), 0)
    const hemi = mix(uGround, uSky, vNormal.y.mul(0.5).add(0.5))
    const light = uSunColor.mul(ndl.mul(vLight.x)).add(hemi.mul(ambient).mul(max(vLight.x, vLight.y))).add(0.04)
    const rgb = albedo.rgb.mul(light).mul(vAO)

    if (mode === 'opaque') {
      m.colorNode = vec4(rgb, 1)
    } else if (mode === 'cutout') {
      m.colorNode = vec4(rgb, albedo.a)
      m.alphaTest = 0.5
      m.side = THREE.DoubleSide
    } else {
      m.colorNode = vec4(rgb, albedo.a.mul(0.85))
      m.transparent = true
      m.depthWrite = false
    }
    return m
  }

  return {
    opaque: build('opaque'), cutout: build('cutout'), translucent: build('translucent'),
    lighting: { sunDir, sunColor, skyColor, groundColor, ambient },
  }
}
