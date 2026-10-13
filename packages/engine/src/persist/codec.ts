async function through(b: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = await new Response(new Blob([b as BlobPart]).stream().pipeThrough(stream)).arrayBuffer()
  return new Uint8Array(out)
}

/** Save blobs are gzip: CompressionStream exists in every browser we target and in Node. */
export const gzip = (b: Uint8Array): Promise<Uint8Array> => through(b, new CompressionStream('gzip'))
export const gunzip = (b: Uint8Array): Promise<Uint8Array> => through(b, new DecompressionStream('gzip'))

/** A blob's name: the SHA-256 of its bytes, lowercase hex. */
export async function sha256(b: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource))
  let s = ''
  for (const x of d) s += x.toString(16).padStart(2, '0')
  return s
}
