import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, SHOP } from './helpers.mjs';

const ENV = { TRYON_ENGINE: 'cloudflare', CF_ACCOUNT_ID: 'a', CF_API_TOKEN: 't' };
const q = (t) => t.call('GET', `/api/product?shop=${SHOP}&handle=classic-wool-beanie&variant=1001`);

test('product page: out of credits (message or hidden), then topped up, shows again at once', async () => {
  const t = await boot({ env: ENV });
  await t.store.putShop(SHOP, { status: 'installed', credits: { balance: 0, purchased: 0, spent: 0 }, creditUnit: 'credit', widget: { zeroCreditMode: 'message' } });
  let r = await q(t);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual([r.json.tryable, r.json.outOfCredits, r.json.category?.id], [false, true, 'hat'], 'message mode: the block shows with a note');
  await t.store.putShop(SHOP, { ...(await t.store.getShop(SHOP)), widget: { zeroCreditMode: 'hide' } });
  r = await q(t);
  assert.equal(r.json.category, null, 'hide mode: the block hides');
  await t.store.adjustCredits(SHOP, 500000, { type: 'topup' });
  // a stale copy of the store (read before the top-up, without creditUnit) must not touch the balance
  const { creditUnit: _u, ...stale } = await t.store.getShop(SHOP);
  await t.store.putShop(SHOP, { ...stale, credits: { balance: 0 } });
  r = await q(t);
  assert.deepEqual([r.json.tryable, r.json.outOfCredits, r.json.category?.id], [true, false, 'hat']);
  assert.equal((await t.store.getShop(SHOP)).credits.balance, 500000);
  await t.close();
});

test('product lookup: missing product is a plain 404; a password-protected storefront says so', async () => {
  const { fetchProduct } = await import('../lib/products.js');
  const admin = async (url) => (url.includes('/admin/') ? new Response(JSON.stringify({ products: [] }), { status: 200 }) : new Response('', { status: 302, headers: { location: 'https://x.myshopify.com/password' } }));
  await assert.rejects(fetchProduct({ fetch: admin, shop: 'x.myshopify.com', handle: 'nope', token: 't' }), (e) => e.status === 404);
  await assert.rejects(fetchProduct({ fetch: admin, shop: 'x.myshopify.com', handle: 'nope' }), (e) => e.status === 403 && /password-protected/.test(e.message));
});

test('Admin API is GraphQL only: one product, the whole catalogue and variant photos', async () => {
  const { makeWorld } = await import('./helpers.mjs');
  const { fetchProduct, fetchAllProducts, pickVariant } = await import('../lib/products.js');
  const w = makeWorld();
  const p = await fetchProduct({ fetch: w.fetch, shop: SHOP, handle: 'classic-wool-beanie', token: 'shpat_secret' });
  assert.equal(p.id, '111');
  assert.deepEqual(p.variants.map((v) => v.id), ['1001', '1002', '1003']);
  assert.match(pickVariant(p, '1002').image, /blue\.jpg$/);
  const all = await fetchAllProducts({ fetch: w.fetch, shop: SHOP, token: 'shpat_secret' });
  assert.deepEqual(all.map((x) => x.handle), ['classic-wool-beanie', 'kinky-straight', 'hair-oil']);
  assert.ok(w.adminPaths.length >= 3 && w.adminPaths.every((x) => x.endsWith('/graphql.json')), 'no REST Admin calls');
  assert.ok(w.adminPaths.every((x) => x.includes('/2026-10/')));
});

test('privacy webhooks: customers/redact removes a shopper; shop/redact removes everything; App Bridge gets the client ID', async () => {
  const { hmacB64 } = await import('./helpers.mjs');
  const t = await boot({ env: { ...ENV, SHOPIFY_API_KEY: 'key123', SHOPIFY_API_SECRET: 'sec' } });
  await t.store.putShop(SHOP, { status: 'installed', credits: { balance: 0 }, creditUnit: 'credit' });
  await t.store.putLead(SHOP, { email: 'ann@example.com', visitor: 'v1' });
  await t.store.putLead(SHOP, { email: 'bob@example.com', visitor: 'v2' });
  await t.store.addEvent(SHOP, { status: 'success', email: 'ann@example.com', customerId: '77', visitor: 'v1', handle: 'x' });
  await t.store.addEvent(SHOP, { status: 'success', email: 'bob@example.com', visitor: 'v2', handle: 'x' });
  const hook = (topic, obj) => { const raw = Buffer.from(JSON.stringify(obj)); return t.call('POST', '/webhooks/shopify', raw, { 'x-shopify-hmac-sha256': hmacB64(raw, 'sec'), 'x-shopify-topic': topic, 'x-shopify-shop-domain': SHOP }); };
  assert.equal((await hook('customers/data_request', { shop_domain: SHOP, customer: { id: 77, email: 'ann@example.com' }, data_request: { id: 9 } })).status, 200);
  assert.equal((await hook('customers/redact', { shop_domain: SHOP, customer: { id: 77, email: 'ann@example.com' } })).status, 200);
  assert.deepEqual((await t.store.listLeads(SHOP)).map((l) => l.email), ['bob@example.com']);
  const ev = await t.store.listEvents(SHOP);
  assert.equal(ev.length, 2, 'counts stay');
  assert.equal(ev.filter((e) => e.email === 'ann@example.com' || e.customerId === '77').length, 0, 'but Ann is gone');
  assert.equal((await hook('shop/redact', { shop_domain: SHOP })).status, 200);
  assert.equal(await t.store.getShop(SHOP), null);
  assert.deepEqual([(await t.store.listLeads(SHOP)).length, (await t.store.listEvents(SHOP)).length], [0, 0]);
  const page = await t.call('GET', '/app');
  assert.match(page.text, /<meta name="shopify-api-key" content="key123">\s*<script src="https:\/\/cdn\.shopify\.com\/shopifycloud\/app-bridge\.js">/);
  await t.close();
});

test('Shopify webhooks also arrive at /app/webhooks/shopify (relative uri resolved against application_url)', async () => {
  const { hmacB64 } = await import('./helpers.mjs');
  const t = await boot({ env: { ...ENV, SHOPIFY_API_SECRET: 'sec' } });
  await t.store.putShop(SHOP, { status: 'installed', token: 'x', credits: { balance: 0 }, creditUnit: 'credit' });
  const raw = Buffer.from(JSON.stringify({ shop_domain: SHOP }));
  const r = await t.call('POST', '/app/webhooks/shopify', raw, { 'x-shopify-hmac-sha256': hmacB64(raw, 'sec'), 'x-shopify-topic': 'app/uninstalled', 'x-shopify-shop-domain': SHOP });
  assert.equal(r.status, 200);
  assert.equal((await t.store.getShop(SHOP)).status, 'disconnected');
  const bad = await t.call('POST', '/app/webhooks/shopify', raw, { 'x-shopify-hmac-sha256': 'nope', 'x-shopify-topic': 'shop/redact', 'x-shopify-shop-domain': SHOP });
  assert.equal(bad.status, 401, 'signature still checked');
  await t.close();
});

test('embedded login: says which Shopify key is wrong, and tolerates pasted spaces or quotes', async () => {
  const crypto = await import('node:crypto');
  const { verifyShopifyIdToken } = await import('../lib/shopifyEmbeddedAuth.js');
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url'); const now = Math.floor(Date.now() / 1000);
  const tok = (aud, secret) => { const h = b({ alg: 'HS256' }), p = b({ aud, dest: 'https://a-store.myshopify.com', sub: '1', exp: now + 60, nbf: now - 5 }); return `${h}.${p}.${crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`; };
  assert.equal(verifyShopifyIdToken(tok('485f130b0e61', 'right'), { SHOPIFY_API_KEY: ' 485f130b0e61\n', SHOPIFY_API_SECRET: '"right" ' }).shop, 'a-store.myshopify.com');
  assert.throws(() => verifyShopifyIdToken(tok('485f130b0e61', 'right'), { SHOPIFY_API_KEY: 'bfcf4a40c26c', SHOPIFY_API_SECRET: 'old' }), /this is app 485f130b…, but the server's SHOPIFY_API_KEY is bfcf4a40…/);
  assert.throws(() => verifyShopifyIdToken(tok('485f130b0e61', 'right'), { SHOPIFY_API_KEY: '485f130b0e61', SHOPIFY_API_SECRET: 'wrong' }), /SHOPIFY_API_SECRET is not the client secret of app 485f130b…/);
});

test('expiring offline tokens: token exchange asks for them, stores the refresh token, and refreshes before expiry', async () => {
  const { makeWorld } = await import('./helpers.mjs');
  const { createTokens, tokenFields } = await import('../lib/tokens.js');
  const { exchangeShopifyIdToken } = await import('../lib/shopifyEmbeddedAuth.js');
  const { decryptToken } = await import('../lib/shopifyAuth.js');
  const { createFileStore } = await import('../lib/store.js');
  const env = { SHOPIFY_API_KEY: 'key', SHOPIFY_API_SECRET: 'sec', TOKEN_ENC_KEY: 'k'.repeat(32) };
  const w = makeWorld(); const store = createFileStore(null);
  const got = await exchangeShopifyIdToken({ fetch: w.fetch, token: 'id.token.x', shop: SHOP, env });
  assert.equal(w.tokenRequests[0].expiring, '1');
  assert.deepEqual([got.expiresIn, got.refreshToken], [3600, w.refreshToken]);
  let clock = 1_000_000;
  await store.putShop(SHOP, { status: 'installed', ...tokenFields(got, env, clock) });
  const tokens = createTokens({ store, env, fetch: w.fetch, now: () => clock });
  assert.equal(await tokens.get(SHOP), 'shpat_secret');
  assert.equal(w.tokenRequests.length, 1, 'fresh token: no refresh');
  clock += 58 * 60 * 1000; // 2 minutes left
  const before = w.refreshToken;
  const [a, b] = await Promise.all([tokens.get(SHOP), tokens.get(SHOP)]);
  assert.deepEqual([a, b], ['shpat_secret', 'shpat_secret']);
  assert.equal(w.tokenRequests.filter((r) => r.grant_type === 'refresh_token').length, 1, 'one refresh for two callers');
  const rec = await store.getShop(SHOP);
  assert.notEqual(decryptToken(rec.refreshToken, env), before, 'the new refresh token is stored');
  assert.equal(decryptToken(rec.refreshToken, env), w.refreshToken);
  assert.equal(rec.tokenExpiresAt, clock + 3600 * 1000);
});

test('APP_URL pasted as …/app still gives correct payment links, and old /app/billing links redirect', async () => {
  const t = await boot({ env: { ...ENV, APP_URL: ' https://api.lookveya.com/app/ ' } });
  const r = await fetch(t.base + '/app/billing/shopify/return?payment=abc&charge_id=1', { redirect: 'manual' });
  assert.equal(r.status, 307);
  assert.equal(r.headers.get('location'), '/billing/shopify/return?payment=abc&charge_id=1');
  const priv = await t.call('GET', '/privacy');
  assert.equal(priv.status, 200);
  await t.close();
});
