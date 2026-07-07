import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { Middleware } from './types.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
};

export interface StaticOptions {
  /** Directory to serve from. */
  dir: string;
  /** URL prefix to mount under. Default: '/'. */
  prefix?: string;
  /** Serve `index.html` for directory requests. Default: true. */
  index?: boolean;
}

/**
 * Static file middleware (Express `express.static` parity). Falls through to
 * `next()` when the path doesn't resolve to a file, so routes and static
 * assets can share a URL space.
 */
export function serveStatic(options: StaticOptions): Middleware {
  const root = path.resolve(options.dir);
  const prefix = normalizePrefix(options.prefix ?? '/');
  const serveIndex = options.index ?? true;

  return async (ctx, next) => {
    if (ctx.method !== 'GET' && ctx.method !== 'HEAD') return next();

    const pathname = decodePathname(ctx.path);
    if (pathname === null || !pathname.startsWith(prefix)) return next();

    const relative = pathname.slice(prefix.length);
    const resolved = path.resolve(root, '.' + path.posix.normalize('/' + relative));
    // Path traversal guard: the resolved file must stay inside the root.
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return next();

    let filePath = resolved;
    try {
      let info = await stat(filePath);
      if (info.isDirectory()) {
        if (!serveIndex) return next();
        filePath = path.join(filePath, 'index.html');
        info = await stat(filePath);
      }
      if (!info.isFile()) return next();

      const headers: Record<string, string> = {
        'content-type': MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        'content-length': String(info.size),
        'last-modified': info.mtime.toUTCString(),
      };
      if (ctx.method === 'HEAD') return new Response(null, { headers });
      const body = Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream;
      return new Response(body, { headers });
    } catch {
      return next();
    }
  };
}

function normalizePrefix(prefix: string): string {
  let p = prefix.startsWith('/') ? prefix : '/' + prefix;
  if (!p.endsWith('/')) p += '/';
  return p;
}

function decodePathname(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}
