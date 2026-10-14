import { REGION_FORMAT } from './regions.ts'
import { SECTION_VERSIONS, type SectionName } from '../sim/snapshot.ts'
import { SYSTEM_SECTION, type SystemSection } from '../sim/systems.ts'

export const FORMAT_VERSION = 1

/** A blob in the store: the SHA-256 of its gzip bytes, and how many bytes. */
export interface BlobRef { hash: string; bytes: number }

/** The JSON that names a save (spec §3); every blob it lists must be in the store. */
export interface Manifest {
  format: 'elovox-save'; formatVersion: number; engine: string; created: string
  /** Bumped on every write of the slot; the store keeps the two newest (an atomic write). */
  generation: number
  seed: number; size: [number, number, number]; tick: number; paused: boolean
  /** Block names by id, air first. */
  blocks: string[]
  /** For the editor and later regeneration; never used to rebuild voxels. */
  terrain: unknown
  /** Small labels for slot lists (the sandbox puts its scene here). */
  meta: Record<string, string | number>
  regionFormat: number
  /** Engine sections, the app's and the game systems' (`system:name`, checked by the game: checkSystemSections). */
  sections: ({ name: SectionName | 'app' | SystemSection; version: number } & BlobRef)[]
  regions: ({ r: number } & BlobRef)[]
}
export type ManifestDraft = Omit<Manifest, 'generation' | 'sections' | 'regions'>

/** `stale`: an incremental save reused blobs that are gone (the slot was deleted meanwhile); save again in full. */
export type SaveErrorCode = 'missing' | 'incompatible' | 'corrupted' | 'quota' | 'unavailable' | 'not-ready' | 'invalid' | 'stale'
export class SaveError extends Error {
  readonly code: SaveErrorCode
  constructor(code: SaveErrorCode, message: string) { super(message); this.name = 'SaveError'; this.code = code }
}

/** Every incompatibility, one per line; empty when this engine can load it. */
export function checkManifest(m: Manifest): string[] {
  if (m.format !== 'elovox-save') return ['not an Elovox save']
  const out: string[] = []
  if (m.formatVersion !== FORMAT_VERSION) out.push(`format v${m.formatVersion}, engine expects v${FORMAT_VERSION}`)
  if (m.regionFormat !== REGION_FORMAT) out.push(`region format v${m.regionFormat}, engine expects v${REGION_FORMAT}`)
  for (const s of m.sections) {
    if (s.name.startsWith(SYSTEM_SECTION)) continue // the game checks these (checkSystemSections)
    const want = (SECTION_VERSIONS as Record<string, number | undefined>)[s.name]
    if (want === undefined) out.push(`section ${s.name} is unknown to this engine`)
    else if (s.version !== want) out.push(`section ${s.name} v${s.version}, engine expects v${want}`)
  }
  return out
}

/** A game's check of its own system sections before booting a save (plan deviation D2). Empty when they match. */
export function checkSystemSections(m: Manifest, systems: readonly { name: string; version: number }[]): string[] {
  const saved = new Map(m.sections.filter(s => s.name.startsWith(SYSTEM_SECTION)).map(s => [s.name.slice(SYSTEM_SECTION.length), s.version]))
  const out: string[] = []
  for (const s of systems) {
    const v = saved.get(s.name)
    if (v === undefined) out.push(`section system:${s.name} is missing`)
    else if (v !== s.version) out.push(`section system:${s.name} v${v}, game expects v${s.version}`)
    saved.delete(s.name)
  }
  for (const name of saved.keys()) out.push(`section system:${name} is unknown to this game`)
  return out
}

/** The saved block table must be a prefix of this engine's (plan deviation 2): appending blocks is fine. Empty when it is. */
export function checkBlocks(saved: readonly string[], names: readonly string[]): string[] {
  for (let i = 0; i < saved.length; i++) {
    if (i >= names.length) return [`block ${i} "${saved[i]}" is unknown to this engine`]
    if (saved[i] !== names[i]) return [`block ${i} is "${saved[i]}" in the save but "${names[i]}" in this engine`]
  }
  return []
}
