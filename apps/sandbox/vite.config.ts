import { defineConfig, type Plugin } from 'vite'

const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

// Saving a document from the editor writes src/terrain/*.terrain.json; a page reload would lose the undo history.
// The file stays watched, so Vite drops its cached transform (a manual reload then serves the saved world), but
// hotUpdate returns no modules, so nothing is sent to the page.
const quietTerrainSaves: Plugin = {
  name: 'quiet-terrain-saves',
  hotUpdate({ file }) {
    if (file.endsWith('.terrain.json')) return []
  },
}

export default defineConfig({
  plugins: [quietTerrainSaves],
  server: { headers: isolation, port: 5173, strictPort: true },
  preview: { headers: isolation, port: 4173, strictPort: true },
  worker: { format: 'es' },
  build: { target: 'es2022' },
})
