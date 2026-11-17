import test from 'node:test';
import assert from 'node:assert/strict';
import { createFileStore } from '../lib/store.js';
import { createNotifier, applyNotifyUpdate, withNotifyDefaults, publicNotify, localParts } from '../lib/notify.js';
import { withDefaults } from '../lib/billing.js';
import { createApp } from '../server.js';

const env = { TOKEN_ENCRYPTION_KEY: 'k'.repeat(64) };
const SID = 'AC' + 'a'.repeat(32);
function world() {
  const store = createFileStore(null);
  const sent = [];
  const f = async (url, o) => { sent.push({ url, body: Object.fromEntries(o.body) }); return new Response(JSON.stringify({ sid: 'SM1' }), { status: 201 }); };
  const audits = [];
  const n = createNotifier({ store, env, fetch: f, getSettings: async () => withDefaults(await store.getSettings()), audit: async (a, d) => audits.push({ a, ...d }), appUrl: 'https://lookonn.vercel.app' });
  return { store, sent, n, audits };
}
async function smsOn(store) {
  await store.putDoc('notify', applyNotifyUpdate(withNotifyDefaults({}), { sms: { enabled: true, accountSid: SID, authToken: 'tok', from: '+14155550123' }, alerts: { phones: '+919876543210' } }, env));
}

test('settings: validation, encrypted secrets, nothing secret sent to the panel', () => {
  const n = applyNotifyUpdate(withNotifyDefaults({}), { email: { host: 'smtp.gmail.com', from: 'a@b.co', pass: 'app-pass', enabled: true }, alerts: { emails: 'a@b.co, c@d.co' } }, env);
  assert.match(n.email.pass, /^enc1:/);
  assert.deepEqual(n.alerts.emails, ['a@b.co', 'c@d.co']);
  const pub = publicNotify(n, { appUrl: 'https://x.app' });
  assert.equal(pub.email.pass, undefined); assert.equal(pub.email.passSet, true);
  assert.match(pub.schedule.url, /^https:\/\/x\.app\/cron\/run\?key=[0-9a-f]{36}$/);
  assert.throws(() => applyNotifyUpdate(n, { alerts: { phones: '98765' } }, env), /international format/);
  assert.throws(() => applyNotifyUpdate(n, { sms: { enabled: true } }, env), /Account SID/);
  assert.throws(() => applyNotifyUpdate(n, { schedule: { everyHours: 2 } }, env), /1, 3, 6, 12 or 24/);
  assert.deepEqual(localParts(Date.UTC(2026, 10, 17, 3, 30), 'Asia/Kolkata'), { day: '2026-11-17', hour: 9 });
});

test('a store crossing the low line is alerted once, then again only when it runs out', async () => {
  const { store, sent, n } = world();
  await smsOn(store);
  await store.putShop('a.myshopify.com', { status: 'installed', token: 'x' });
  await store.adjustCredits('a.myshopify.com', 25_000, { type: 'topup' });
  await n.afterTryon('a.myshopify.com');
  assert.equal(sent.length, 0, 'above the line: nothing sent');
  await store.adjustCredits('a.myshopify.com', -10_000, { type: 'tryon' }); // 15 images left, warning at 20
  await n.afterTryon('a.myshopify.com');
  assert.equal(sent.length, 1);
  assert.match(sent[0].url, new RegExp(`/Accounts/${SID}/Messages.json$`));
  assert.equal(sent[0].body.To, '+919876543210');
  assert.match(sent[0].body.Body, /low: 15 images left/);
  await store.adjustCredits('a.myshopify.com', -1000, { type: 'tryon' });
  await n.afterTryon('a.myshopify.com');
  assert.equal(sent.length, 1, 'still low: no repeat inside the cooldown');
  await store.adjustCredits('a.myshopify.com', -14_000, { type: 'tryon' });
  await n.afterTryon('a.myshopify.com');
  assert.equal(sent.length, 2); assert.match(sent[1].body.Body, /OUT of credits/);
  await store.adjustCredits('a.myshopify.com', 100_000, { type: 'topup' });
  await n.afterTryon('a.myshopify.com');
  assert.equal(Object.keys((await store.getDoc('notifyState')).shops).length, 0, 'topped up: the next drop alerts again');
});

test('usage report, Gemini balance estimate and the scheduler', async () => {
  const { store, sent, n } = world();
  await smsOn(store);
  await store.putShop('b.myshopify.com', { status: 'installed', token: 'x' });
  await store.adjustCredits('b.myshopify.com', 100_000, { type: 'topup' });
  const s = withDefaults({});
  for (let i = 0; i < 14; i++) { await store.adjustCredits('b.myshopify.com', -1000, { type: 'tryon' }); await n.recordAiCall(s); }
  await store.putDoc('notify', applyNotifyUpdate(await n.get(), { gemini: { balance: 1200, lowBelow: 1000 } }, env));
  const r = await n.report();
  assert.equal(r.totals.imagesLeft, 86); assert.equal(r.totals.used7, 14);
  assert.equal(r.items[0].perDay, 2); assert.equal(r.items[0].daysLeft, 43);
  assert.equal(r.totals.upcomingCost, 86 * 15);
  assert.equal(r.gemini.spent, 14 * 15); assert.equal(r.gemini.left, 1200 - 210); assert.equal(r.gemini.low, true);
  const out = await n.run({ force: true });
  assert.equal(out.checked, true); assert.equal(out.summary, true);
  assert.ok(sent.some((x) => /Gemini balance about INR 990/.test(x.body.Body)));
  assert.ok(sent.some((x) => /lookOn yesterday/.test(x.body.Body)));
  const again = await n.run();
  assert.equal(again.checked, false, 'not due yet'); assert.equal(again.summary, false, 'one summary a day');
});

test('/cron/run needs the CRON_SECRET or the scheduler key', async () => {
  const app = await createApp({ env: { ...env, CRON_SECRET: 'cron-secret-123', DATA_FILE: 'memory' }, store: createFileStore(null), engine: null });
  const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.equal((await fetch(`${base}/cron/run`)).status, 401);
    assert.equal((await fetch(`${base}/cron/run`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    const ok = await fetch(`${base}/cron/run`, { headers: { Authorization: 'Bearer cron-secret-123' } });
    assert.equal(ok.status, 200); assert.equal((await ok.json()).ok, true);
  } finally { srv.close(); }
});

test('Gemini token counts are read and priced at Google rates', async () => {
  const { readUsage } = await import('../lib/engines/gemini.js');
  const u = readUsage({ model: 'gemini-nano-banana-2.1', usage: { total_input_tokens: 2700, total_output_tokens: 1130, total_thought_tokens: 200, total_tokens: 4030, output_tokens_by_modality: [{ modality: 'image', tokens: 1120 }, { modality: 'text', tokens: 10 }] } });
  assert.deepEqual(u, { model: 'gemini-nano-banana-2.1', input: 2700, output: 1130, image: 1120, text: 10, thought: 200, total: 4030 });
  assert.equal(readUsage({ usage: { total_input_tokens: 5, total_output_tokens: 1120 } }).image, 1120, 'no split: a picture answer is image output');
  assert.equal(readUsage({}), null);
  const { store, n } = world();
  await n.recordAiCall(withDefaults({}), u); // USD 94 = INR 1 at the default rate
  const [row] = await store.listUsage('');
  const usd = (2700 * 1.5 + 210 * 7.5 + 1120 * 30) / 1e6;
  assert.equal(row.usdMicro, Math.round(usd * 1e6));
  assert.equal(row.costMilli, Math.round(usd * 94 * 1000));
  assert.equal(row.imageTokens, 1120); assert.equal(row.measured, 1);
  const r = await n.report();
  assert.equal(r.tokens.total, 4030); assert.equal(r.tokens.perCall, 4030);
});
