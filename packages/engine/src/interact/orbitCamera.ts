import type { WorldSize } from '../world/layout.ts'

export interface OrbitOptions {
  worldSize: WorldSize
  minDistance?: number
  maxDistance?: number
  minPitch?: number
  maxPitch?: number
  damping?: number
  moveSpeed?: number
  heightAt?: (x: number, z: number) => number
}
export interface CameraLike { position: { set(x: number, y: number, z: number): unknown }; lookAt(x: number, y: number, z: number): unknown }
export interface OrbitState { target: [number, number, number]; yaw: number; pitch: number; distance: number }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const EDGE_PX = 12

export class OrbitCamera {
  readonly goal: OrbitState
  readonly current: OrbitState
  lastDragDistance = 0
  private readonly o: Required<Omit<OrbitOptions, 'heightAt'>> & Pick<OrbitOptions, 'heightAt'>
  private readonly keys = new Set<string>()
  private edge: [number, number] = [0, 0]

  constructor(options: OrbitOptions) {
    this.o = {
      minDistance: 8, maxDistance: 400, minPitch: 0.15, maxPitch: 1.45, damping: 10, moveSpeed: 1.2, ...options,
    }
    const [sx, , sz] = options.worldSize
    this.goal = { target: [sx / 2, 0, sz / 2], yaw: 0.7, pitch: 0.85, distance: 70 }
    this.current = { ...this.goal, target: [...this.goal.target] }
  }

  rotate(dYaw: number, dPitch: number): void {
    this.goal.yaw += dYaw
    this.goal.pitch = clamp(this.goal.pitch + dPitch, this.o.minPitch, this.o.maxPitch)
  }

  zoom(deltaY: number): void {
    this.goal.distance = clamp(this.goal.distance * Math.exp(deltaY * 0.001), this.o.minDistance, this.o.maxDistance)
  }

  /** Drag-pan in screen pixels: the ground follows the cursor. */
  pan(dxPx: number, dyPx: number): void {
    const k = this.goal.distance * 0.0015
    this.translate(dyPx * k, -dxPx * k)
  }

  /** Continuous movement (WASD / screen edge): forward and right in [-1, 1]. */
  move(forward: number, right: number, dt: number): void {
    const speed = this.o.moveSpeed * this.goal.distance
    this.translate(forward * speed * dt, right * speed * dt)
  }

  update(dt: number): void {
    const f = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0) - this.edge[1]
    const r = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0) + this.edge[0]
    if (f || r) this.move(clamp(f, -1, 1), clamp(r, -1, 1), dt)
    if (this.o.heightAt) this.goal.target[1] = this.o.heightAt(this.goal.target[0], this.goal.target[2])
    const t = 1 - Math.exp(-this.o.damping * dt)
    const c = this.current, g = this.goal
    for (let i = 0; i < 3; i++) c.target[i] = c.target[i]! + (g.target[i]! - c.target[i]!) * t
    c.yaw += (g.yaw - c.yaw) * t
    c.pitch += (g.pitch - c.pitch) * t
    c.distance += (g.distance - c.distance) * t
  }

  apply(camera: CameraLike): void {
    const { target, yaw, pitch, distance } = this.current
    const cp = Math.cos(pitch)
    camera.position.set(target[0] + distance * cp * Math.sin(yaw), target[1] + distance * Math.sin(pitch), target[2] + distance * cp * Math.cos(yaw))
    camera.lookAt(target[0], target[1], target[2])
  }

  attach(canvas: HTMLCanvasElement): () => void {
    let dragging = false
    let lx = 0, ly = 0
    const down = (e: PointerEvent) => {
      if (e.button !== 1 && e.button !== 2) return
      dragging = true
      this.lastDragDistance = 0
      lx = e.clientX; ly = e.clientY
      canvas.setPointerCapture(e.pointerId)
    }
    const move = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      const ex = e.clientX - rect.left, ey = e.clientY - rect.top
      this.edge = [ex < EDGE_PX ? -1 : ex > rect.width - EDGE_PX ? 1 : 0, ey < EDGE_PX ? -1 : ey > rect.height - EDGE_PX ? 1 : 0]
      if (!dragging) return
      const dx = e.clientX - lx, dy = e.clientY - ly
      lx = e.clientX; ly = e.clientY
      this.lastDragDistance += Math.abs(dx) + Math.abs(dy)
      this.rotate(-dx * 0.005, dy * 0.005)
    }
    const up = (e: PointerEvent) => { if (dragging) { dragging = false; canvas.releasePointerCapture(e.pointerId) } }
    const leave = () => { this.edge = [0, 0] }
    const wheel = (e: WheelEvent) => { e.preventDefault(); this.zoom(e.deltaY) }
    const menu = (e: Event) => e.preventDefault()
    const kd = (e: KeyboardEvent) => this.keys.add(e.code)
    const ku = (e: KeyboardEvent) => this.keys.delete(e.code)
    const blur = () => this.keys.clear()
    canvas.addEventListener('pointerdown', down)
    canvas.addEventListener('pointermove', move)
    canvas.addEventListener('pointerup', up)
    canvas.addEventListener('pointerleave', leave)
    canvas.addEventListener('wheel', wheel, { passive: false })
    canvas.addEventListener('contextmenu', menu)
    window.addEventListener('keydown', kd)
    window.addEventListener('keyup', ku)
    window.addEventListener('blur', blur)
    return () => {
      canvas.removeEventListener('pointerdown', down)
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerup', up)
      canvas.removeEventListener('pointerleave', leave)
      canvas.removeEventListener('wheel', wheel)
      canvas.removeEventListener('contextmenu', menu)
      window.removeEventListener('keydown', kd)
      window.removeEventListener('keyup', ku)
      window.removeEventListener('blur', blur)
    }
  }

  private translate(forward: number, right: number): void {
    const { yaw } = this.goal
    const t = this.goal.target
    t[0] = clamp(t[0] + -Math.sin(yaw) * forward + Math.cos(yaw) * right, 0, this.o.worldSize[0])
    t[2] = clamp(t[2] + -Math.cos(yaw) * forward - Math.sin(yaw) * right, 0, this.o.worldSize[2])
  }
}
