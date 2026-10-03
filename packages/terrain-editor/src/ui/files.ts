/** The part of a FileSystemFileHandle the editor uses. */
export interface FileHandle {
  readonly name: string
  getFile(): Promise<{ text(): Promise<string> }>
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>
}

/** The File System Access pickers; `window` in Chrome and Edge. Missing methods mean no API. */
export interface FileHost {
  showOpenFilePicker?(o?: unknown): Promise<FileHandle[]>
  showSaveFilePicker?(o?: unknown): Promise<FileHandle>
}

export interface OpenedFile { name: string; text: string; handle: FileHandle | null }

/** Opening and saving where the API is missing: a file input and a download. */
export interface FileFallback {
  pick(): Promise<OpenedFile | null>
  download(name: string, text: string): void
}

const TYPES = [{ description: 'Elovox terrain', accept: { 'application/json': ['.json'] } }]

const isAbort = (e: unknown) => typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError'

export class TerrainFiles {
  private readonly host: FileHost
  private readonly fallback: FileFallback

  constructor(host: FileHost, fallback: FileFallback) {
    this.host = host
    this.fallback = fallback
  }

  /** The browser can write back to the file it opened. */
  get native(): boolean { return typeof this.host.showOpenFilePicker === 'function' && typeof this.host.showSaveFilePicker === 'function' }

  /** Asks for a file; null if the user cancelled. */
  async open(): Promise<OpenedFile | null> {
    if (!this.host.showOpenFilePicker) return this.fallback.pick()
    try {
      const [h] = await this.host.showOpenFilePicker({ types: TYPES, multiple: false })
      if (!h) return null
      const file = await h.getFile()
      return { name: h.name, text: await file.text(), handle: h }
    } catch (e) {
      if (isAbort(e)) return null
      throw e
    }
  }

  /** Writes to `handle`, or asks where to save when there is none (Save as). Null if the user cancelled. */
  async save(text: string, handle: FileHandle | null, suggestedName: string): Promise<{ handle: FileHandle | null; name: string } | null> {
    if (!this.host.showSaveFilePicker) {
      this.fallback.download(suggestedName, text)
      return { handle: null, name: suggestedName }
    }
    let h = handle
    if (!h) {
      try {
        h = await this.host.showSaveFilePicker({ types: TYPES, suggestedName })
      } catch (e) {
        if (isAbort(e)) return null
        throw e
      }
    }
    const w = await h.createWritable()
    await w.write(text)
    await w.close()
    return { handle: h, name: h.name }
  }
}

/** Fallback for browsers without the API: a hidden file input to open and a link click to download. */
export function browserFallback(doc: Document): FileFallback {
  return {
    pick: () => new Promise((resolve) => {
      const input = doc.createElement('input')
      input.type = 'file'
      input.accept = '.json,application/json'
      input.addEventListener('change', async () => {
        const file = input.files?.[0]
        resolve(file ? { name: file.name, text: await file.text(), handle: null } : null)
      })
      input.addEventListener('cancel', () => resolve(null))
      input.click()
    }),
    download(name, text) {
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
      const a = doc.createElement('a')
      a.href = url
      a.download = name
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 0)
    },
  }
}
