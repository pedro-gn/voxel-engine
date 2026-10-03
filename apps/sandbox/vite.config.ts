import { defineConfig } from 'vite'

const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  // Saving a document from the editor writes src/terrain/*.terrain.json; a reload would lose the undo history.
  server: { headers: isolation, port: 5173, strictPort: true, watch: { ignored: ['**/*.terrain.json'] } },
  preview: { headers: isolation, port: 4173, strictPort: true },
  worker: { format: 'es' },
  build: { target: 'es2022' },
})
