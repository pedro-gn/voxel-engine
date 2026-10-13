import { isAppState } from './appState.ts'

export const SCENES = ['world', 'diorama', 'terrain', 'flood', 'caves', 'collapse', 'workers', 'living', 'crowd'] as const
export type SceneName = typeof SCENES[number]

/** `?scene=`: a known scene name, else the plain world. */
export function sceneOf(raw: string | null): SceneName {
  return (SCENES as readonly string[]).includes(raw ?? '') ? raw as SceneName : 'world'
}

/**
 * What the page boots. From a save (`?save=`), the save's scene wins over `?scene`, `?size` and `?seed`, and its terrain
 * document over the one the URL would pick.
 */
export function bootPlan(params: URLSearchParams, saved: { app: unknown; manifest?: { terrain: unknown } } | null): { scene: SceneName; fromSave: boolean; terrain?: unknown } {
  if (saved) return { scene: isAppState(saved.app) ? sceneOf(saved.app.scene) : 'world', fromSave: true, terrain: saved.manifest?.terrain ?? undefined }
  return { scene: sceneOf(params.get('scene')), fromSave: false }
}
