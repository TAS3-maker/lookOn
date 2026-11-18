import crypto from 'node:crypto';

const b64 = (value) => Buffer.from(value).toString('base64url');
const unb64 = (value) => Buffer.from(value, 'base64url');

// Values pasted into a hosting dashboard often carry a space, a newline or quotes; Shopify's are plain letters and digits.
export const cleanKey = (v) => String(v || '').trim().replace(/^["']|["']$/g, '').trim();

export function verifyShopifyIdToken(token, env = process.env) {
  const secret = cleanKey(env.SHOPIFY_API_SECRET);
  const clientId = cleanKey(env.SHOPIFY_API_KEY);
  const [head, body, signature, extra] = String(token || '').split('.');
  if (!secret || !clientId || extra || !head || !body || !signature) throw new Error('Missing Shopify ID token.');
  const expected = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest();
  const actual = unb64(signature);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    // Say which server setting is wrong. The client ID inside the token is public; the secret is never shown.
    let aud = '';
    try { aud = String(JSON.parse(unb64(body).toString('utf8')).aud || ''); } catch { /* unreadable token */ }
    const short = (x) => (x ? `${x.slice(0, 8)}…` : 'none');
    if (aud && aud !== clientId) throw new Error(`Setup problem: this is app ${short(aud)}, but the server's SHOPIFY_API_KEY is ${short(clientId)}. Set SHOPIFY_API_KEY and SHOPIFY_API_SECRET to this app's client ID and secret, then redeploy.`);
    throw new Error(`Setup problem: the server's SHOPIFY_API_SECRET is not the client secret of app ${short(clientId)}. Copy the secret again from the Dev Dashboard (Settings), set it on the server and redeploy.`);
  }
  let payload;
  try { payload = JSON.parse(unb64(body).toString('utf8')); } catch { throw new Error('Invalid Shopify ID token payload.'); }
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== clientId || !payload.dest || !payload.sub || Number(payload.exp) <= now || Number(payload.nbf || 0) > now) throw new Error('Invalid or expired Shopify ID token.');
  const shop = new URL(payload.dest).hostname.toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) throw new Error('Invalid Shopify store in ID token.');
  return { ...payload, shop };
}

export async function exchangeShopifyIdToken({ fetch: fetchFn = globalThis.fetch, token, shop, env = process.env }) {
  const response = await fetchFn(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      client_id: cleanKey(env.SHOPIFY_API_KEY),
      client_secret: cleanKey(env.SHOPIFY_API_SECRET),
      subject_token: token,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      // Shopify's token-exchange namespace is `urn:shopify`, not the
      // generic OAuth token-type namespace. The latter causes a 400.
      requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
      // Public apps must use expiring offline tokens (1 hour, with a 90-day refresh token).
      expiring: '1',
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    // Keep credentials and the ID token out of logs, but retain Shopify's
    // diagnostic code so a failed deployment can be diagnosed from Vercel.
    console.error('[shopify-token-exchange]', shop, response.status, data.error || 'unknown', data.error_description || '');
    throw new Error(`Shopify token exchange failed (${response.status}).`);
  }
  return tokenResult(data);
}

/** The parts of a Shopify token response the app keeps. */
export function tokenResult(data) {
  return {
    token: data.access_token,
    scope: data.scope || '',
    expiresIn: Number(data.expires_in) || 0,
    refreshToken: data.refresh_token || '',
    refreshExpiresIn: Number(data.refresh_token_expires_in) || 0,
  };
}
