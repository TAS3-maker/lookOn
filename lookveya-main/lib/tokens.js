// Shopify access tokens for each store.
// Public apps must use expiring offline tokens: the access token lasts about 1 hour and comes with a refresh token
// (about 90 days). Each refresh returns a new pair, which must be stored; the old refresh token is then retired.
// Every Admin API call asks this module for the token, so it is refreshed shortly before it expires.
import { encryptToken, decryptToken } from './shopifyAuth.js';
import { cleanKey } from './shopifyEmbeddedAuth.js';

const EARLY_MS = 5 * 60 * 1000; // refresh when less than 5 minutes are left

/** Fields to store on the shop record for a token response (encrypted). */
export function tokenFields(result, env, now = Date.now()) {
  return {
    token: encryptToken(result.token, env),
    scope: result.scope || '',
    tokenExpiresAt: result.expiresIn ? now + result.expiresIn * 1000 : null,
    refreshToken: result.refreshToken ? encryptToken(result.refreshToken, env) : null,
    refreshTokenExpiresAt: result.refreshExpiresIn ? now + result.refreshExpiresIn * 1000 : null,
  };
}

export function createTokens({ store, env, fetch: f, now = () => Date.now() }) {
  const inFlight = new Map(); // one refresh per store at a time (refreshing twice would retire the first result)

  async function refresh(shop) {
    const rec = await store.getShop(shop);
    const refreshToken = decryptToken(rec?.refreshToken, env);
    if (!refreshToken) return null;
    let res, data = {};
    try {
      res = await f(`https://${shop}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ client_id: cleanKey(env.SHOPIFY_API_KEY), client_secret: cleanKey(env.SHOPIFY_API_SECRET), grant_type: 'refresh_token', refresh_token: refreshToken }),
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });
      data = await res.json().catch(() => ({}));
    } catch (e) {
      console.error('[token-refresh]', shop, e?.message || e);
      return null; // network trouble: try again on the next call, keep the stored pair
    }
    if (!res.ok || !data.access_token) {
      console.error('[token-refresh]', shop, res.status, data.error || '', data.error_description || '');
      return null; // the merchant reopening lookveya gets a fresh pair through token exchange
    }
    const fresh = await store.getShop(shop);
    await store.putShop(shop, {
      ...(fresh || rec), ...tokenFields({ token: data.access_token, scope: data.scope || fresh?.scope, expiresIn: Number(data.expires_in) || 0, refreshToken: data.refresh_token || '', refreshExpiresIn: Number(data.refresh_token_expires_in) || 0 }, env, now()),
    });
    return data.access_token;
  }

  /** A usable Admin API token for this store, refreshed if it is about to expire; null if there is none. */
  async function get(shop, record) {
    const rec = record || (await store.getShop(shop));
    if (!rec?.token || rec.status === 'disconnected') return null;
    const current = decryptToken(rec.token, env);
    if (!rec.tokenExpiresAt) return current; // an older non-expiring token: replaced next time the merchant opens lookveya
    if (current && rec.tokenExpiresAt - now() > EARLY_MS) return current;
    if (!inFlight.has(shop)) inFlight.set(shop, refresh(shop).finally(() => inFlight.delete(shop)));
    const renewed = await inFlight.get(shop);
    return renewed || (rec.tokenExpiresAt > now() ? current : null);
  }

  return { get, refresh };
}
