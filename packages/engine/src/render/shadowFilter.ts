import {
  dFdx, dFdy, dot, float, Fn, interleavedGradientNoise, reference, renderGroup, screenCoordinate,
  texture, vec2, vec3, vogelDiskSample,
} from 'three/tsl'

// TSL's node types do not describe the shadow filter's named inputs.
type N = any

/**
 * The sun's PCF filter, with receiver-plane depth correction.
 * Comparing every neighbouring tap against the centre depth self-shadows a sloping receiver in light space:
 * a perfectly flat voxel face gets faint bands which move with the fitted shadow map. Evaluate the receiver's
 * depth at each tap instead, keeping the same five-tap Vogel disk and softness as three's PCF filter.
 */
export const receiverPlanePCF = Fn(({ depthTexture, shadowCoord, shadow }: N, builder: N) => {
  const dx: N = dFdx(vec3(shadowCoord)).toVar(), dy: N = dFdy(vec3(shadowCoord)).toVar()
  const det = dx.x.mul(dy.y).sub(dx.y.mul(dy.x))
  // At an edge-on receiver the UV Jacobian can vanish. A bounded inverse keeps the filter finite.
  const inverse = det.sign().div(det.abs().max(1e-12))
  const slope = vec2(
    dy.y.mul(dx.z).sub(dx.y.mul(dy.z)),
    dx.x.mul(dy.z).sub(dy.x.mul(dx.z)),
  ).mul(inverse).toVar()
  const mapSize: N = (reference('mapSize', 'vec2', shadow) as N).setGroup(renderGroup)
  const radius: N = (reference('radius', 'float', shadow) as N).setGroup(renderGroup)
  const texel: N = vec2(1).div(mapSize)
  // Each hardware bilinear comparison also reaches adjacent texels; cover that footprint, not the whole disk.
  const footprint = dot(slope.abs(), texel)
  const centre = builder.renderer.reversedDepthBuffer ? shadowCoord.z.add(footprint) : shadowCoord.z.sub(footprint)
  const phi = interleavedGradientNoise(screenCoordinate.xy).mul(Math.PI * 2)
  const taps = [0, 1, 2, 3, 4].map(i => {
    const offset = vogelDiskSample(float(i), float(5), phi).mul(radius).mul(texel)
    return texture(depthTexture, shadowCoord.xy.add(offset)).compare(centre.add(dot(slope, offset)))
  })
  return taps.reduce<N>((sum, tap) => sum.add(tap), float(0)).mul(0.2)
})
