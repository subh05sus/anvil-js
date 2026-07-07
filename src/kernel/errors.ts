/** HTTP error that middleware/handlers can throw; the kernel converts it to a JSON response. */
export class HttpError extends Error {
  readonly status: number;
  readonly expose: boolean;
  readonly details?: unknown;

  constructor(status: number, message?: string, opts?: { details?: unknown; expose?: boolean; cause?: unknown }) {
    super(message ?? defaultMessage(status), { cause: opts?.cause });
    this.name = 'HttpError';
    this.status = status;
    // 4xx messages are safe to show clients by default; 5xx are not.
    this.expose = opts?.expose ?? status < 500;
    this.details = opts?.details;
  }
}

/** Raised by the compiler when two route files produce conflicting routes. */
export class RouteConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouteConflictError';
  }
}

function defaultMessage(status: number): string {
  const known: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    409: 'Conflict',
    413: 'Payload Too Large',
    415: 'Unsupported Media Type',
    422: 'Unprocessable Entity',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
  };
  return known[status] ?? `HTTP ${status}`;
}

export function errorToResponse(err: unknown, opts: { dev?: boolean } = {}): Response {
  if (err instanceof HttpError) {
    const body: Record<string, unknown> = {
      error: err.expose ? err.message : defaultMessage(err.status),
      status: err.status,
    };
    if (err.expose && err.details !== undefined) body.details = err.details;
    if (opts.dev && err.stack) body.stack = err.stack;
    return Response.json(body, { status: err.status });
  }
  const body: Record<string, unknown> = { error: 'Internal Server Error', status: 500 };
  if (opts.dev && err instanceof Error) {
    body.error = err.message;
    body.stack = err.stack;
  }
  return Response.json(body, { status: 500 });
}
