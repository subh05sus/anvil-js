# Auth & security

Kernel-level primitives — no external deps, work with any `StateStore`.

## Authentication

```ts
import { authenticate, getUser, bearer, apiKey } from 'anvil-sdk';

const auth = authenticate({
  verify: bearer((token) => (token === process.env.API_TOKEN ? { id: 'svc' } : null)),
  // or: apiKey('x-api-key', (key) => lookupKey(key))
  // or your own: verify: (ctx) => customCheck(ctx)
});

export default auth; // _middleware.ts
```

`bearer`/`apiKey` are verifier helpers; `verify` can be any function of `ctx`. A rejected request gets a `401` with `WWW-Authenticate` (set `realm` to customize); pass `optional: true` to let unauthenticated requests through with `getUser(ctx)` returning `undefined`. Read the attached principal downstream with `getUser(ctx)` (custom `stateKey` if you're attaching more than one principal).

## Sessions

Cookie-backed, `StateStore`-persisted, with fixation defense — a presented session id is never adopted unless it's already a live record; otherwise a fresh id is minted.

```ts
import { session, getSession } from 'anvil-sdk';
import { MemoryStateStore } from 'anvil-sdk/store';

export default session({
  store: new MemoryStateStore(), // or SqliteStateStore
  secret: process.env.SESSION_SECRET!, // string[] to rotate secrets
  ttlMs: 24 * 60 * 60 * 1000, // default: 24h, rolling
});
```

```ts
const sess = getSession(ctx)!;
sess.set('userId', user.id);
await sess.regenerate(); // rotate id on privilege elevation (e.g. after login)
await sess.destroy();    // clear + expire the cookie
```

The cookie value is HMAC-signed (`signValue`/`unsignValue` in `anvil-sdk`, if you need raw cookie signing elsewhere); writes are lazy — an untouched new session is never persisted.

## Rate limiting

```ts
import { rateLimit } from 'anvil-sdk';

export default rateLimit({
  limit: 100,
  windowMs: 60_000,
  algorithm: 'fixed-window', // or 'token-bucket' for smoother bursts
  // store: redisStore,       // default: bounded in-memory Map (maxKeys: 100_000)
});
```

Keyed by client IP by default (see below); pass `keyFn` to key by user/API key instead. Emits `RateLimit-*` / `Retry-After` headers and a `429` on breach. Pass a `store` (any `StateStore`) to share limits across instances.

## Body size limits

```ts
import { bodyLimit } from 'anvil-sdk';

export default bodyLimit({ maxBytes: 1_000_000 });
```

A `Content-Length` over the cap is rejected immediately (`413`); the cap is also enforced while `ctx.body()` streams the request, so a chunked upload with no declared length can't bypass it.

## Trusted client IP

```ts
import { getClientIp } from 'anvil-sdk';

const ip = getClientIp(ctx, { trustProxy: true }); // trust X-Forwarded-For behind your proxy
```

The Node adapter injects the socket's real address into an internal header and strips any client-supplied copy of it first, so `getClientIp` is un-spoofable by default. Only pass `trustProxy: true` behind a proxy you control — `X-Forwarded-For` is otherwise client-settable.
