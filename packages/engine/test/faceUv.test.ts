import { describe, expect, it } from 'vitest'
import { FLIP_U, faceUV } from '../src/render/faceUv.ts'
import { FACE, FACE_NORMALS } from '../src/mesh/vertexFormat.ts'

const cross = (a: readonly number[], b: readonly number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!]

describe('faceUV', () => {
  it('flips u on +X and −Z only', () => {
    expect(FLIP_U).toEqual([true, false, false, false, false, true])
  })
  it.each([FACE.PX, FACE.NX, FACE.PZ, FACE.NZ])('runs u along the viewer\'s right and v up on side face %i', (f) => {
    const n = FACE_NORMALS[f]!
    const right = cross([-n[0], -n[1], -n[2]], [0, 1, 0]) // looking at the face from outside, head up
    const p = [3, 4, 5]
    const [u0, v0] = faceUV(f, p[0]!, p[1]!, p[2]!)
    const [u1] = faceUV(f, p[0]! + right[0]! * 0.5, p[1]!, p[2]! + right[2]! * 0.5)
    const [, v1] = faceUV(f, p[0]!, p[1]! + 0.5, p[2]!)
    expect(u1).toBeGreaterThan(u0)
    expect(v1).toBeGreaterThan(v0)
  })
})
