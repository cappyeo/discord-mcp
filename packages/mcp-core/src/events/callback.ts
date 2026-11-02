import { randomUUID, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import ipaddr from 'ipaddr.js';
import { Webhook } from 'standardwebhooks';

export class CallbackError extends Error {
  constructor(public readonly reason: string) {
    super('Callback endpoint rejected');
  }
}
export function publicAddress(address: string): boolean {
  try {
    const ip = ipaddr.process(address);
    return ip.range() === 'unicast';
  } catch {
    return false;
  }
}
export function callbackUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CallbackError('invalid_url');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== '443')
  ) {
    throw new CallbackError('invalid_url');
  }
  return url;
}
export function validateSecret(secret: string): void {
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw new Error('Invalid signing secret');
  const encoded = secret.slice(6);
  const key = Buffer.from(encoded, 'base64');
  if (
    key.length < 24 ||
    key.length > 64 ||
    key.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')
  ) {
    throw new Error('Invalid signing secret');
  }
}
export type WebhookPost = (
  url: string,
  body: string,
  headers: Record<string, string>,
) => Promise<{ status: number; body: string }>;
/** Fresh DNS validation and pinned address on EVERY connection; no redirects or socket reuse. */
export const webhookPost: WebhookPost = async (value, body, headers) => {
  const url = callbackUrl(value);
  let addresses: Array<{ address: string; family: number }>;
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    addresses = await Promise.race([
      lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true }),
      new Promise<never>((_resolve, reject) => {
        dnsTimer = setTimeout(() => reject(new CallbackError('dns_timeout')), 3000);
      }),
    ]);
  } catch (error) {
    throw error instanceof CallbackError ? error : new CallbackError('dns_failed');
  } finally {
    clearTimeout(dnsTimer);
  }
  if (addresses.length === 0 || addresses.some(({ address }) => !publicAddress(address)))
    throw new CallbackError('non_public_address');
  const selected = addresses[0]!;
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'POST',
        agent: false,
        // A fixed family disables automatic family selection and its all:true lookup.
        family: selected.family,
        headers: { ...headers, 'Content-Length': String(Buffer.byteLength(body)) },
        // Connect to the checked IP. URL hostname remains the TLS/Host identity.
        lookup: (_host, _options, cb) => cb(null, selected.address, selected.family),
        signal: AbortSignal.timeout(10_000),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 16_384) {
            res.destroy();
            reject(new CallbackError('response_too_large'));
          } else chunks.push(chunk);
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 500, body: Buffer.concat(chunks).toString() }),
        );
        res.on('error', () => reject(new CallbackError('connection_failed')));
      },
    );
    req.on('error', () => reject(new CallbackError('timeout_or_connection_failed')));
    req.end(body);
  });
};
export async function signedPost(
  post: WebhookPost,
  sub: { id: string; url: string; secret: string; old_secret?: string; rotate_until?: number },
  id: string,
  body: string,
  now = Date.now(),
) {
  if (Buffer.byteLength(body) > 262_144) throw new Error('Event payload too large');
  const at = new Date(now);
  const signature = new Webhook(sub.secret).sign(id, at, body);
  const old =
    sub.old_secret && (sub.rotate_until ?? 0) > now
      ? ` ${new Webhook(sub.old_secret).sign(id, at, body)}`
      : '';
  return post(sub.url, body, {
    'Content-Type': 'application/json',
    'webhook-id': id,
    'webhook-timestamp': String(Math.floor(now / 1000)),
    'webhook-signature': signature + old,
    'X-MCP-Subscription-Id': sub.id,
  });
}
export async function verifyCallback(
  post: WebhookPost,
  sub: { id: string; url: string; secret: string },
) {
  const challenge = randomUUID();
  const started = Date.now();
  const response = await signedPost(
    post,
    sub,
    `verification_${randomUUID()}`,
    JSON.stringify({ type: 'verification', challenge }),
  );
  let echoed: unknown;
  try {
    echoed = JSON.parse(response.body).challenge;
  } catch {
    throw new CallbackError('challenge_failed');
  }
  if (
    Date.now() - started > 10_000 ||
    response.status < 200 ||
    response.status >= 300 ||
    typeof echoed !== 'string'
  )
    throw new CallbackError('challenge_failed');
  const a = Buffer.from(echoed);
  const b = Buffer.from(challenge);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new CallbackError('challenge_failed');
}
