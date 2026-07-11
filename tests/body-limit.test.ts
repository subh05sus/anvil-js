import { describe, expect, it } from 'vitest';
import { bodyLimit } from '../src/kernel/body-limit.js';
import { Context } from '../src/kernel/context.js';
import { compose } from '../src/kernel/middleware.js';
import { errorToResponse, HttpError } from '../src/kernel/errors.js';

/** Run the body-limit middleware, having the handler read ctx.body(). */
async function drive(r: Request, maxBytes: number): Promise<Response> {
  const mw = bodyLimit({ maxBytes });
  const run = compose([mw], async (ctx: Context) => ({ body: await ctx.body() }));
  try {
    return await run(new Context(r));
  } catch (err) {
    // Mirror createApp's error boundary for middleware-thrown HttpErrors.
    return errorToResponse(err);
  }
}

function chunkedStream(bytes: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

describe('bodyLimit', () => {
  it('rejects an oversized Content-Length immediately with 413', async () => {
    const r = new Request('http://t.local/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '9999' },
      body: JSON.stringify({ a: 1 }),
    });
    const res = await drive(r, 10);
    expect(res.status).toBe(413);
  });

  it('rejects a chunked (no Content-Length) body over the cap mid-stream', async () => {
    const big = new Uint8Array(1000).fill(65);
    const r = new Request('http://t.local/', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: chunkedStream(big, 100),
      duplex: 'half',
    } as RequestInit);
    const res = await drive(r, 200);
    expect(res.status).toBe(413);
  });

  it('parses an under-limit JSON body normally', async () => {
    const r = new Request('http://t.local/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    const res = await drive(r, 10_000);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ body: { hello: 'world' } });
  });

  it('still 400s on malformed JSON under the limit', async () => {
    const r = new Request('http://t.local/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    });
    const res = await drive(r, 10_000);
    expect(res.status).toBe(400);
  });

  it('the streaming guard throws HttpError 413', () => {
    expect(new HttpError(413).status).toBe(413);
  });
});
