import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { ReadableStream as WebStream } from 'node:stream/web';
import { createGunzip } from 'node:zlib';

export const USER_AGENT = 'feed-lint (+https://github.com/mscode-pl/feed-lint)';

// Covers the whole download, so it is generous enough for feeds of a few hundred MB.
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

export const isUrl =(input: string) => /^https?:\/\//i.test(input);

export async function openInput(input: string): Promise<AsyncIterable<Uint8Array>> {
  if (isUrl(input)) {
    const response = await fetch(input, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/xml, text/xml, */*' },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) throw new Error(`${input}: HTTP ${response.status} ${response.statusText}`.trim());
    const body = Readable.fromWeb(response.body as WebStream<Uint8Array>);
    // fetch only undoes Content-Encoding; a .gz file served as a download stays compressed.
    const gzipFile = /\.gz(?:$|\?)/i.test(input) && /gzip|octet-stream/i.test(response.headers.get('content-type') ?? '');
    return gzipFile ? body.pipe(createGunzip()) : body;
  }

  const info = await stat(input).catch(() => undefined);
  if (!info?.isFile()) throw new Error(`${input}: file not found`);
  const stream = createReadStream(input);
  return /\.gz$/i.test(input) ? stream.pipe(createGunzip()) : stream;
}
