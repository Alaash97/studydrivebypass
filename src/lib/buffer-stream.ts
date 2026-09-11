const DEFAULT_CHUNK_SIZE = 64 * 1024;

export function bufferToStream(
  buffer: Uint8Array,
  chunkSize = DEFAULT_CHUNK_SIZE,
): ReadableStream<Uint8Array> {
  let offset = 0;

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= buffer.byteLength) {
        controller.close();
        return;
      }

      const end = Math.min(offset + chunkSize, buffer.byteLength);
      controller.enqueue(buffer.slice(offset, end));
      offset = end;
    },
  });
}
