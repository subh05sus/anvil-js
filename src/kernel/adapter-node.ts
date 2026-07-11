import http from 'node:http';
import { Readable } from 'node:stream';
import { REMOTE_ADDR_HEADER } from './net.js';

export interface ServeOptions {
  port?: number;
  hostname?: string;
}

export interface AnvilServer {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}

/** Anything with a web-standard fetch handler — an Anvil App or a bare MCP handler. */
export interface Fetchable {
  fetch: (request: Request) => Promise<Response>;
}

/**
 * Bridge Node's http.Server to a web-standard fetch handler.
 * The handler can be swapped at runtime (dev-server reloads) by passing
 * a getter instead of a fixed instance.
 */
export function serve(app: Fetchable | (() => Fetchable), options: ServeOptions = {}): Promise<AnvilServer> {
  const getApp = typeof app === 'function' ? app : () => app;

  const server = http.createServer(async (req, res) => {
    // Client disconnect → abort the request signal, which agent routes thread
    // into model and tool calls so an abandoned run stops (PRD §11 edge #3).
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    try {
      const request = toWebRequest(req, controller.signal);
      const response = await getApp().fetch(request);
      await writeResponse(res, response, req.method === 'HEAD');
    } catch (err) {
      // Adapter-level failure (malformed request, stream error) — the app's own
      // error boundary never saw it.
      console.error('[anvil] adapter error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ error: 'Internal Server Error', status: 500 }));
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 3000, options.hostname ?? '0.0.0.0', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : (options.port ?? 3000);
      resolve({
        server,
        port,
        close: () =>
          new Promise<void>((res2, rej2) => {
            server.close((err) => (err ? rej2(err) : res2()));
          }),
      });
    });
  });
}

export function toWebRequest(req: http.IncomingMessage, signal?: AbortSignal): Request {
  const host = req.headers.host ?? 'localhost';
  const url = `http://${host}${req.url ?? '/'}`;

  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!;
    // Node core strips these from being set on outgoing fetch Requests.
    if (name.toLowerCase() === 'transfer-encoding') continue;
    headers.append(name, req.rawHeaders[i + 1]!);
  }

  // Thread the real client IP as a trusted header. Drop any client-forged copy
  // first, then set it from the socket, so `getClientIp` can't be spoofed.
  headers.delete(REMOTE_ADDR_HEADER);
  const remoteAddr = req.socket?.remoteAddress;
  if (remoteAddr) headers.set(REMOTE_ADDR_HEADER, remoteAddr);

  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';

  return new Request(url, {
    method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as unknown as ReadableStream) : undefined,
    signal,
    // Required by undici when passing a stream body.
    duplex: 'half',
  } as RequestInit);
}

export async function writeResponse(
  res: http.ServerResponse,
  response: Response,
  isHead = false,
): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of response.headers) {
    if (key === 'set-cookie') continue;
    headers[key] = value;
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) headers['set-cookie'] = cookies;

  res.writeHead(response.status, headers);

  if (isHead || !response.body) {
    if (response.body) await response.body.cancel();
    res.end();
    return;
  }

  const nodeStream = Readable.fromWeb(response.body as never);
  await new Promise<void>((resolve, reject) => {
    nodeStream.pipe(res);
    nodeStream.on('error', reject);
    res.on('finish', resolve);
    res.on('close', resolve);
  });
}
