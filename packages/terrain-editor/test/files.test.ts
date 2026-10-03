import { describe, expect, it } from 'vitest'
import { TerrainFiles, type FileFallback, type FileHandle, type FileHost, type OpenedFile } from '../src/ui/files.ts'

function handle(name: string, text = '') {
  const written: string[] = []
  const h: FileHandle = {
    name,
    getFile: async () => ({ text: async () => text }),
    createWritable: async () => ({ write: async (d: string) => { written.push(d) }, close: async () => {} }),
  }
  return { h, written }
}
const abort = () => Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' })
function fallback(picked: OpenedFile | null = null) {
  const downloads: [string, string][] = []
  const f: FileFallback = { pick: async () => picked, download: (n, t) => { downloads.push([n, t]) } }
  return { f, downloads }
}

describe('TerrainFiles with the File System Access API', () => {
  it('opens a file and keeps its handle', async () => {
    const { h } = handle('map.terrain.json', '{"a":1}')
    const files = new TerrainFiles({ showOpenFilePicker: async () => [h], showSaveFilePicker: async () => h }, fallback().f)
    expect(files.native).toBe(true)
    expect(await files.open()).toEqual({ name: 'map.terrain.json', text: '{"a":1}', handle: h })
  })

  it('returns null when the user cancels a picker', async () => {
    const host: FileHost = { showOpenFilePicker: async () => { throw abort() }, showSaveFilePicker: async () => { throw abort() } }
    const files = new TerrainFiles(host, fallback().f)
    expect(await files.open()).toBeNull()
    expect(await files.save('x', null, 'a.terrain.json')).toBeNull()
  })

  it('writes to the open handle without asking', async () => {
    const { h, written } = handle('map.terrain.json')
    let asked = false
    const files = new TerrainFiles({ showOpenFilePicker: async () => [h], showSaveFilePicker: async () => { asked = true; return h } }, fallback().f)
    expect(await files.save('text', h, 'ignored.json')).toEqual({ handle: h, name: 'map.terrain.json' })
    expect(written).toEqual(['text'])
    expect(asked).toBe(false)
  })

  it('asks where to save when there is no handle (Save as)', async () => {
    const { h, written } = handle('new.terrain.json')
    const files = new TerrainFiles({ showOpenFilePicker: async () => [h], showSaveFilePicker: async () => h }, fallback().f)
    expect(await files.save('text', null, 'showcase.terrain.json')).toEqual({ handle: h, name: 'new.terrain.json' })
    expect(written).toEqual(['text'])
  })

  it('passes other picker errors on', async () => {
    const files = new TerrainFiles({ showOpenFilePicker: async () => { throw new Error('denied') } }, fallback().f)
    await expect(files.open()).rejects.toThrow('denied')
  })
})

describe('TerrainFiles write failures', () => {
  it('aborts the writable and rethrows when write fails', async () => {
    let aborted = false
    const h: FileHandle = {
      name: 'm.json',
      getFile: async () => ({ text: async () => '' }),
      createWritable: async () => ({ write: async () => { throw new Error('disk full') }, close: async () => {}, abort: async () => { aborted = true } }),
    }
    const files = new TerrainFiles({ showOpenFilePicker: async () => [h], showSaveFilePicker: async () => h }, fallback().f)
    await expect(files.save('x', h, 'm.json')).rejects.toThrow('disk full')
    expect(aborted).toBe(true)
  })
})

describe('TerrainFiles without the API', () => {
  it('opens through the fallback picker and saves by download', async () => {
    const picked = { name: 'a.json', text: '{}', handle: null }
    const { f, downloads } = fallback(picked)
    const files = new TerrainFiles({}, f)
    expect(files.native).toBe(false)
    expect(await files.open()).toBe(picked)
    expect(await files.save('text', null, 'showcase.terrain.json')).toEqual({ handle: null, name: 'showcase.terrain.json' })
    expect(downloads).toEqual([['showcase.terrain.json', 'text']])
  })
})
