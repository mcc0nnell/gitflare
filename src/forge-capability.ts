const encoder = new TextEncoder();
const REPO = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/;
function b64url(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, c => String.fromCharCode(c)).join(''))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function from64(s: string): Uint8Array {
  if (!/^[a-zA-Z0-9_-]+$/.test(s) || s.length > 600) throw new Error('Invalid capability encoding');
  const text = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4));
  return Uint8Array.from(text, ch => ch.charCodeAt(0));
}
async function signingKey(secret: string): Promise<CryptoKey> {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('Signing key not provisioned');
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function issueReadCapability(secret: string, repo: string, now = Date.now(), ttlSeconds = 300): Promise<string> {
  if (!REPO.test(repo) || !Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 900) throw new Error('Invalid capability scope');
  const payload = b64url(encoder.encode(JSON.stringify({
    v: 1, scope: 'forge:events:read', repo,
    expires: Math.floor(now / 1000) + ttlSeconds,
    nonce: crypto.randomUUID(),
  })));
  const mac = await crypto.subtle.sign('HMAC', await signingKey(secret), encoder.encode('gf1.' + payload));
  return 'gf1.' + payload + '.' + b64url(new Uint8Array(mac));
}
export async function verifyReadCapability(secret: string, token: string | null, repo: string, now = Date.now()): Promise<boolean> {
  if (!REPO.test(repo) || typeof token !== 'string' || token.length > 900) return false;
  try {
    const [prefix, payload, signature, extra] = token.split('.');
    if (prefix !== 'gf1' || extra !== undefined || !payload || !signature) return false;
    const payloadBytes = from64(payload);
    if (b64url(payloadBytes) !== payload) return false;
    const decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes));
    if (!decoded || decoded.v !== 1 || decoded.scope !== 'forge:events:read' || decoded.repo !== repo ||
        !Number.isSafeInteger(decoded.expires) || decoded.expires <= Math.floor(now / 1000) ||
        decoded.expires > Math.floor(now / 1000) + 900 ||
        typeof decoded.nonce !== 'string' || decoded.nonce.length !== 36) return false;
    const bytes = new Uint8Array(from64(signature));
    if (bytes.byteLength !== 32 || b64url(bytes) !== signature) return false;
    return crypto.subtle.verify('HMAC', await signingKey(secret), bytes, encoder.encode(prefix + '.' + payload));
  } catch {
    return false;
  }
}
