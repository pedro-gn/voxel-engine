// Prints the checksum of the routeFuzz worlds' flat and hierarchical routes (run once on 5845093 to pin it).
import { NavigationSystem } from '../src/sim/navigation/navigation.ts'
import { RegionStore } from '../src/sim/navigation/regions.ts'
import { RouteSearch } from '../src/sim/navigation/routeSearch.ts'
import { fuzzWorld, standing } from './fuzzWorld.ts'

export function routeChecksum(worlds = 40, pairs = 25): number {
  let h = 0x811c9dc5
  const mix = (n: number) => { h = Math.imul(h ^ (n & 0xffff), 16777619) >>> 0; h = Math.imul(h ^ (n >>> 16), 16777619) >>> 0 }
  for (let seed = 1; seed <= worlds; seed++) {
    const { layout, rng, port } = fuzzWorld(seed), nav = new NavigationSystem(port, 1 << 20), store = new RegionStore(nav)
    for (let i = 0; i < pairs; i++) {
      const start = standing(nav, layout, rng), goal = standing(nav, layout, rng)
      const flat = nav.request(start, [goal])
      while (flat.status === 'pending') nav.step(1 << 20)
      mix(flat.cost); mix(flat.path.length); for (const p of flat.path) mix(p)
      const route = new RouteSearch(nav, store, start, [goal])
      while (route.status === 'pending') route.step(4096)
      mix(route.cost); for (const e of route.exits) mix(e)
    }
  }
  return h
}
