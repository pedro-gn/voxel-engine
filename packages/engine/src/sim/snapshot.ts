/** A save's per-system sections (spec §3). Pending commands are not saved (plan deviation 3). */
export type SectionName = 'scheduler' | 'water' | 'gravity' | 'collapse' | 'workers'
/** Bumped when a section's packed layout changes; a save with another version is refused (persist/manifest.ts). */
export const SECTION_VERSIONS: Readonly<Record<SectionName | 'app', number>> = { scheduler: 1, water: 1, gravity: 1, collapse: 1, workers: 1, app: 1 }

/** One save region's voxels (persist/regions.ts), by region index. */
export interface RegionBlob { r: number; bytes: Uint8Array }

/** What the sim hands a save, taken between two ticks. */
export interface SimSnapshot {
  tick: number; paused: boolean
  /** Every save region's write revision at the snapshot: the baseline of the next incremental save. */
  revisions: Uint32Array
  /** Only the regions asked for. */
  regions: RegionBlob[]
  sections: { name: SectionName; bytes: Uint8Array }[]
  /** Wall time the sim spent: its stall. */
  ms: number
}

/** What a sim boots from instead of generating. */
export interface SimRestore {
  tick: number; paused: boolean
  /** Every region of the world. */
  regions: RegionBlob[]
  sections: Partial<Record<SectionName, Uint8Array>>
}
