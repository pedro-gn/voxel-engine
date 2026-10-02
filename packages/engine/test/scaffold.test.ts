import { describe, expect, it } from 'vitest'
import { ENGINE_VERSION } from '../src/version.ts'

describe('scaffold', () => {
  it('exposes a version and supports SharedArrayBuffer', () => {
    expect(ENGINE_VERSION).toBe('0.1.0')
    expect(typeof SharedArrayBuffer).toBe('function')
  })
})
