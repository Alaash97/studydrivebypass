import { describe, expect, it } from 'vitest';
import { bufferToStream } from './buffer-stream';

describe('bufferToStream', () => {
  it('streams the complete buffer in bounded chunks', async () => {
    const source = new Uint8Array([1, 2, 3, 4, 5]);
    const reader = bufferToStream(source, 2).getReader();
    const chunks: number[][] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Array.from(value));
    }

    expect(chunks).toEqual([[1, 2], [3, 4], [5]]);
  });
});
