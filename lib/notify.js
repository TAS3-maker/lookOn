// Usage, alerts and the scheduler for the super admin.
//
//  - Usage: credits every store still holds, how fast each one uses them, when it runs out, and what the images
//    still owed will cost you on Gemini. AI calls are counted per hour (retries included), so the Gemini figure is real spend.
//  - Alerts: email (SMTP) and SMS or WhatsApp (Twilio) when a store runs low or out of credit, when your Gemini balance
//    runs low, and a daily summary. A store alert goes out the moment a try-on crosses the line; the scheduler sweeps
//    every store as a safety net and sends the summary.
//  - Gemini has no API for the prepay balance, so you type in what AI Studio shows; lookOn subtracts the AI calls made since.
import crypto from 'node:crypto';
import { encryptToken, decryptToken } from './shopifyAuth.js';
import { creditSummary, paginate } from './billing.js';

export const GEMINI_BILLING_URL = 'https://aistudio.google.com/billing';
const H = 3600_000, DAY = 24 * H;

export const NOTIFY_DEFAULTS = Object.freeze({
  email: { enabled: false, host: '', port: 587, secure: false, user: '', pass: '', from: '' },
  sms: { enabled: false, channel: 'sms', accountSid: '', authToken: '', from: '' },
  alerts: { emails: [], phones: [], storeLow: true, storeEmpty: true, geminiLow: true, dailySummary: true, merchants: false, cooldownHours: 24 },
  schedule: { enabled: true, everyHours: 6, summaryHour: 9, timezone: 'Asia/Kolkata', key: '' },
  // Prices per million tokens in USD (Gemini API standard tier, Nano Banana 2.1). usdRate: USD -> your cost currency; empty = the exchange rate on Credit logic.
  gemini: { billingUrl: GEMINI_BILLING_URL, balance: null, balanceAt: null, lowBelow: 1000, inputPerM: 1.5, textOutPerM: 7.5, imageOutPerM: 30, usdRate: null },
});

export function withNotifyDefaults(stored = {}) {
  const out = {};
  for (const [k, v] of Object.entries(NOTIFY_DEFAULTS)) out[k] = { ...v, ...(stored?.[k] || {}) };
  out.alerts.emails = [...(out.alerts.emails || [])];
  out.alerts.phones = [...(out.alerts.phones || [])];
  return out;
}

/** Safe to send to the panel: passwords replaced by "...Set" flags. */
export function publicNotify(n, { appUrl = '', cronSecret = false } = {}) {
  const out = JSON.parse(JSON.stringify(n));
  out.email.passSet = Boolean(n.email.pass); delete out.email.pass;
  out.sms.authTokenSet = Boolean(n.sms.authToken); delete out.sms.authToken;
  out.schedule.url = n.schedule.key && appUrl ? `${appUrl}/cron/run?key=${n.schedule.key}` : '';
  delete out.schedule.key;
  out.schedule.vercelCron = cronSecret;
  return out;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+[1-9]\d{7,14}$/;
const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,\n;]/)).map((x) => String(x).trim()).filter(Boolean);
function validTimezone(tz) { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }

/** Validate an update from the panel. Secrets change only when a new value is sent. Throws on bad input. */
export function applyNotifyUpdate(current, body = {}, env = process.env) {
  const n = withNotifyDefaults(JSON.parse(JSON.stringify(current)));
  const err = (m) => { const e = new Error(m); e.status = 400; throw e; };
  const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
  const e = body.email;
  if (e) {
    if (e.enabled !== undefined) n.email.enabled = Boolean(e.enabled);
    for (const k of ['host', 'user', 'from']) if (e[k] !== undefined) n.email[k] = str(e[k]);
    if (e.port !== undefined) { const p = Number(e.port); if (!Number.isInteger(p) || p < 1 || p > 65535) err('SMTP port must be a number such as 587 or 465.'); n.email.port = p; }
    if (e.secure !== undefined) n.email.secure = Boolean(e.secure);
    if (typeof e.pass === 'string' && e.pass.trim()) n.email.pass = encryptToken(e.pass.trim(), env);
    if (n.email.enabled && (!n.email.host || !n.email.from)) err('Add the SMTP server and the "From" address before switching email on.');
  }
  const s = body.sms;
  if (s) {
    if (s.enabled !== undefined) n.sms.enabled = Boolean(s.enabled);
    if (s.channel !== undefined) { if (!['sms', 'whatsapp'].includes(s.channel)) err('Choose SMS or WhatsApp.'); n.sms.channel = s.channel; }
    if (s.accountSid !== undefined) n.sms.accountSid = str(s.accountSid, 64);
    if (s.from !== undefined) n.sms.from = str(s.from, 40).replace(/^whatsapp:/i, '');
    if (typeof s.authToken === 'string' && s.authToken.trim()) n.sms.authToken = encryptToken(s.authToken.trim(), env);
    if (n.sms.accountSid && !/^AC[0-9a-fA-F]{32}$/.test(n.sms.accountSid)) err('The Twilio Account SID starts with AC and has 34 characters.');
    if (n.sms.from && !PHONE_RE.test(n.sms.from) && !/^MG[0-9a-fA-F]{32}$/.test(n.sms.from)) err('The Twilio "From" number must look like +14155550123 (or a Messaging Service SID starting with MG).');
    if (n.sms.enabled && (!n.sms.accountSid || !n.sms.authToken || !n.sms.from)) err('Add the Twilio Account SID, auth token and "From" number before switching SMS on.');
  }
  const a = body.alerts;
  if (a) {
    if (a.emails !== undefined) { const v = list(a.emails); const bad = v.find((x) => !EMAIL_RE.test(x)); if (bad) err(`"${bad}" is not an email address.`); if (v.length > 10) err('Use at most 10 email addresses.'); n.alerts.emails = v; }
    if (a.phones !== undefined) { const v = list(a.phones).map((x) => x.replace(/[\s()-]/g, '')); const bad = v.find((x) => !PHONE_RE.test(x)); if (bad) err(`"${bad}" is not a phone number. Use the international format, e.g. +919876543210.`); if (v.length > 5) err('Use at most 5 phone numbers.'); n.alerts.phones = v; }
    for (const k of ['storeLow', 'storeEmpty', 'geminiLow', 'dailySummary', 'merchants']) if (a[k] !== undefined) n.alerts[k] = Boolean(a[k]);
    if (a.cooldownHours !== undefined) { const v = Number(a.cooldownHours); if (!Number.isFinite(v) || v < 1 || v > 720) err('Repeat alerts every 1 to 720 hours.'); n.alerts.cooldownHours = v; }
  }
  const c = body.schedule;
  if (c) {
    if (c.enabled !== undefined) n.schedule.enabled = Boolean(c.enabled);
    if (c.everyHours !== undefined) { const v = Number(c.everyHours); if (![1, 3, 6, 12, 24].includes(v)) err('Check every 1, 3, 6, 12 or 24 hours.'); n.schedule.everyHours = v; }
    if (c.summaryHour !== undefined) { const v = Number(c.summaryHour); if (!Number.isInteger(v) || v < 0 || v > 23) err('The summary hour is 0 to 23.'); n.schedule.summaryHour = v; }
    if (c.timezone !== undefined) { const tz = str(c.timezone, 60); if (!validTimezone(tz)) err('Use a time zone such as Asia/Kolkata.'); n.schedule.timezone = tz; }
    if (c.newKey) n.schedule.key = '';
  }
  const g = body.gemini;
  if (g) {
    if (g.billingUrl !== undefined) { const u = str(g.billingUrl, 300) || GEMINI_BILLING_URL; if (!/^https:\/\//.test(u)) err('The Gemini billing link must start with https://'); n.gemini.billingUrl = u; }
    if (g.balance !== undefined) {
      if (g.balance === null || g.balance === '') { n.gemini.balance = null; n.gemini.balanceAt = null; }
      else { const v = Number(g.balance); if (!Number.isFinite(v) || v < 0 || v > 1e9) err('Enter the Gemini balance as a number.'); n.gemini.balance = v; n.gemini.balanceAt = Date.now(); }
    }
    for (const [k, label] of [['inputPerM', 'Input price'], ['textOutPerM', 'Text and thinking output price'], ['imageOutPerM', 'Image output price']]) if (g[k] !== undefined) { const v = Number(g[k]); if (!Number.isFinite(v) || v < 0 || v > 10000) err(`${label} must be a number of USD per million tokens.`); n.gemini[k] = v; }
    if (g.usdRate !== undefined) { if (g.usdRate === null || g.usdRate === '') n.gemini.usdRate = null; else { const v = Number(g.usdRate); if (!Number.isFinite(v) || v <= 0 || v > 1e6) err('Enter how much 1 USD is in your cost currency.'); n.gemini.usdRate = v; } }
    if (g.lowBelow !== undefined) { const v = Number(g.lowBelow); if (!Number.isFinite(v) || v < 0 || v > 1e9) err('Enter the Gemini warning level as a number.'); n.gemini.lowBelow = v; }
  }
  if (!n.schedule.key) n.schedule.key = crypto.randomBytes(18).toString('hex');
  return n;
}

// ---------------- time ----------------
export const hourKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 13);
/** Calendar day and hour in a time zone, e.g. { day: '2026-11-17', hour: 9 }. */
export function localParts(t, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

// ---------------- sending ----------------
export async function sendEmail(cfg, env, { to, subject, text, html }) {
  if (!cfg.enabled) throw new Error('Email is switched off.');
  const nodemailer = (await import('nodemailer')).default;
  const t = nodemailer.createTransport({ host: cfg.host, port: cfg.port, secure: Boolean(cfg.secure), auth: cfg.user ? { user: cfg.user, pass: decryptToken(cfg.pass, env) || '' } : undefined, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000 });
  await t.sendMail({ from: cfg.from, to: list(to).join(', '), subject, text, html });
}

export async function sendSms(cfg, env, f, { to, body }) {
  if (!cfg.enabled) throw new Error('SMS is switched off.');
  const wa = cfg.channel === 'whatsapp';
  const form = new URLSearchParams({ To: wa ? `whatsapp:${to}` : to, Body: body.slice(0, 1500) });
  if (cfg.from.startsWith('MG')) form.set('MessagingServiceSid', cfg.from); else form.set('From', wa ? `whatsapp:${cfg.from}` : cfg.from);
  const auth = Buffer.from(`${cfg.accountSid}:${decryptToken(cfg.authToken, env) || ''}`).toString('base64');
  const r = await f(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`, { method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form, signal: AbortSignal.timeout(15_000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Twilio: ${j.message || `error ${r.status}`}`);
  return j.sid;
}

const escHtml = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function emailHtml(title, lines, link) {
  return `<div style="font:15px/1.55 -apple-system,Segoe UI,Arial,sans-serif;color:#1b1a22;max-width:560px">
<p style="font-weight:800;font-size:18px;margin:0 0 12px">${escHtml(title)}</p>${lines.map((l) => `<p style="margin:0 0 8px">${escHtml(l)}</p>`).join('')}
${link ? `<p style="margin:18px 0 0"><a href="${escHtml(link.url)}" style="background:#5b3fd6;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:700;display:inline-block">${escHtml(link.label)}</a></p>` : ''}
<p style="color:#9b99a8;font-size:12px;margin-top:22px">lookOn alerts</p></div>`;
}

// ---------------- the notifier ----------------
export function createNotifier({ store, env, fetch: f, getSettings, audit, appUrl = '', adminAppUrl = (s) => s, isBilled = () => true }) {
  const get = async () => {
    const n = withNotifyDefaults(await store.getDoc('notify'));
    if (!n.schedule.key) { n.schedule.key = crypto.randomBytes(18).toString('hex'); await store.putDoc('notify', n); }
    return n;
  };
  const getState = async () => ({ shops: {}, gemini: {}, log: [], ...((await store.getDoc('notifyState')) || {}) });
  const saveState = (s) => { s.log = (s.log || []).slice(-50); return store.putDoc('notifyState', s); };

  let cached = null;
  const getCached = async () => { if (!cached || Date.now() - cached.at > 60_000) cached = { at: Date.now(), n: await get() }; return cached.n; };
  /** 1 USD in the cost currency: the Gemini setting, else the Credit logic rate when stores pay in USD. */
  const usdRate = (n, settings) => n.gemini.usdRate || (settings.currency === 'USD' ? settings.fxRate : settings.costCurrency === 'USD' ? 1 : settings.fxRate) || 1;

  /** Count one AI call with the tokens Gemini reported, priced at Google's rates. Without token counts, the flat cost per image is used. */
  async function recordAiCall(settings, usage = null) {
    try {
      const inc = { aiCalls: 1 };
      if (usage) {
        const n = await getCached();
        const usd = (usage.input * n.gemini.inputPerM + (usage.text + usage.thought) * n.gemini.textOutPerM + usage.image * n.gemini.imageOutPerM) / 1e6;
        Object.assign(inc, { measured: 1, inTokens: usage.input, outTokens: usage.output, imageTokens: usage.image, thoughtTokens: usage.thought, usdMicro: Math.round(usd * 1e6), costMilli: Math.round(usd * usdRate(n, settings) * 1000) });
      } else inc.costMilli = Math.round((settings?.aiCostPerImage || 0) * 1000);
      await store.addUsage(hourKey(), inc);
    } catch (e) { console.warn('[usage] could not record:', e.message); }
  }

  /** Send one message to every admin address and number, plus extra emails. Never throws. */
  async function deliver(n, { kind, subject, lines, link, sms }, state) {
    const results = [];
    const emails = n.alerts.emails;
    if (n.email.enabled && emails.length) {
      try { await sendEmail(n.email, env, { to: emails, subject, text: [...lines, link ? `${link.label}: ${link.url}` : ''].join('\n'), html: emailHtml(subject, lines, link) }); results.push({ via: 'email', ok: true }); }
      catch (e) { results.push({ via: 'email', ok: false, error: e.message }); }
    }
    if (n.sms.enabled) for (const to of n.alerts.phones) {
      try { await sendSms(n.sms, env, f, { to, body: sms }); results.push({ via: n.sms.channel, ok: true, to }); }
      catch (e) { results.push({ via: n.sms.channel, ok: false, to, error: e.message }); }
    }
    const entry = { at: Date.now(), kind, subject, sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).map((r) => `${r.via}: ${r.error}`) };
    if (state) state.log.push(entry);
    if (results.length) await audit('alert_sent', { kind, subject, sent: entry.sent, failed: entry.failed.join('; ') || undefined });
    return { ...entry, results };
  }

  /** What one image really costs: Gemini's token counts over the last 30 days (retries included) when there are enough, else the Credit logic figure. */
  async function costPerImage(settings, rows = null) {
    rows ||= await store.listUsage(hourKey(Date.now() - 30 * DAY));
    const measured = rows.reduce((t, u) => t + (u.measured || 0), 0), calls = rows.reduce((t, u) => t + (u.aiCalls || 0), 0);
    if (measured < 10 || measured < calls / 2) return settings.aiCostPerImage || 0;
    return rows.reduce((t, u) => t + (u.costMilli || 0), 0) / 1000 / calls;
  }

  /** Gemini prepay balance: what you typed in, less the AI calls made since (counted per hour). */
  async function geminiStatus(n, settings, storeImages = null) {
    const now = Date.now();
    const weekRows = await store.listUsage(hourKey(now - 7 * DAY));
    const week = weekRows.reduce((t, u) => t + (u.costMilli || 0) / 1000, 0);
    const costPerDay = week / 7;
    const cost = await costPerImage(settings, weekRows);
    const g = { billingUrl: n.gemini.billingUrl, balance: null, lowBelow: n.gemini.lowBelow, costPerDay: Math.round(costPerDay * 100) / 100 };
    if (n.gemini.balance === null || !n.gemini.balanceAt) return g;
    const spent = (await store.listUsage(hourKey(n.gemini.balanceAt))).reduce((t, u) => t + (u.costMilli || 0) / 1000, 0);
    const left = Math.round((n.gemini.balance - spent) * 100) / 100;
    Object.assign(g, { balance: n.gemini.balance, balanceAt: n.gemini.balanceAt, spent: Math.round(spent * 100) / 100, left, imagesLeft: cost > 0 ? Math.max(0, Math.floor(left / cost)) : null, daysLeft: costPerDay > 0 ? Math.round(Math.max(0, left) / costPerDay * 10) / 10 : null, low: left < n.gemini.lowBelow });
    if (storeImages !== null && g.imagesLeft !== null) g.coversStores = g.imagesLeft >= storeImages;
    return g;
  }

  // ---- usage figures ----
  async function report({ page = 1, pageSize = 20, sort = 'daysLeft' } = {}) {
    const settings = await getSettings();
    const n = await get();
    const now = Date.now(), tz = n.schedule.timezone;
    const per = settings.creditsPerTryon || 1, cost = Math.round((await costPerImage(settings)) * 100) / 100;
    const users = new Map((await store.listUsers()).map((u) => [u.id, u]));
    const days = [];
    for (let i = 29; i >= 0; i--) days.push(localParts(now - i * DAY, tz).day);
    const imagesByDay = Object.fromEntries(days.map((d) => [d, 0]));
    const rows = [];
    for (const shop of await store.listShops()) {
      const rec = await store.getShop(shop);
      if (!rec) continue;
      const s = creditSummary(settings, rec);
      const tryons = (await store.listLedger(shop, 2000)).filter((l) => l.type === 'tryon' && l.at >= now - 30 * DAY);
      for (const l of tryons) { const d = localParts(l.at, tz).day; if (d in imagesByDay) imagesByDay[d] += 1; }
      const used7 = tryons.filter((l) => l.at >= now - 7 * DAY).length, used30 = tryons.length;
      const perDay = used7 ? used7 / 7 : used30 / 30;
      const daysLeft = perDay > 0 ? s.imagesLeft / perDay : null;
      const owner = users.get(rec.ownerId);
      rows.push({
        shop, owner: owner ? owner.name || owner.email : rec.ownerId ? 'Account unavailable' : 'Unassigned', ownerId: rec.ownerId || '',
        status: rec.status || (rec.token ? 'installed' : 'unknown'), billed: isBilled(rec),
        credits: s.credits, imagesLeft: s.imagesLeft, low: s.low, empty: s.empty, used7, used30, perDay: Math.round(perDay * 10) / 10,
        daysLeft: daysLeft === null ? null : Math.round(daysLeft * 10) / 10, runsOutAt: daysLeft === null ? null : now + daysLeft * DAY,
        upcomingCost: Math.round(s.imagesLeft * cost * 100) / 100, lastTryOnAt: rec.lastTryOnAt || null,
      });
    }
    const active = rows.filter((r) => r.status === 'installed' && r.billed);
    const sum = (k, list = active) => Math.round(list.reduce((t, r) => t + (r[k] || 0), 0) * 100) / 100;
    // AI calls and their cost, from the hourly counter (includes retries and unbilled stores).
    const usage = await store.listUsage(hourKey(now - 31 * DAY));
    const KEYS = ['aiCalls', 'measured', 'inTokens', 'outTokens', 'imageTokens', 'thoughtTokens', 'usdMicro', 'costMilli'];
    const byDay = Object.fromEntries(days.map((d) => [d, Object.fromEntries(KEYS.map((k) => [k, 0]))]));
    for (const u of usage) { const d = localParts(Date.parse(`${u.hour}:00:00Z`), tz).day; if (byDay[d]) for (const k of KEYS) byDay[d][k] += u[k] || 0; }
    const series = days.map((d) => { const b = byDay[d]; return { day: d, images: imagesByDay[d], aiCalls: b.aiCalls, cost: Math.round(b.costMilli / 10) / 100, usd: Math.round(b.usdMicro / 1e4) / 100, tokens: b.inTokens + b.outTokens + b.thoughtTokens }; });
    const t30 = Object.fromEntries(KEYS.map((k) => [k, days.reduce((t, d) => t + byDay[d][k], 0)]));
    const images30 = series.reduce((t, x) => t + x.images, 0);
    const n30 = await get();
    const tokens = {
      calls: t30.aiCalls, measuredCalls: t30.measured, input: t30.inTokens, output: t30.outTokens, image: t30.imageTokens, thought: t30.thoughtTokens, total: t30.inTokens + t30.outTokens + t30.thoughtTokens,
      usd: Math.round(t30.usdMicro / 1e4) / 100, cost: Math.round(t30.costMilli / 10) / 100,
      perCall: t30.measured ? Math.round((t30.inTokens + t30.outTokens + t30.thoughtTokens) / t30.measured) : null,
      costPerImage: images30 ? Math.round(t30.costMilli / images30 / 10) / 100 : null,
      usdPerImage: images30 && t30.measured ? Math.round(t30.usdMicro / images30) / 1e6 : null,
      usdRate: usdRate(n30, settings), prices: { input: n30.gemini.inputPerM, textOut: n30.gemini.textOutPerM, imageOut: n30.gemini.imageOutPerM },
    };
    const last7 = series.slice(-7);
    const costPerDay = last7.reduce((t, x) => t + x.cost, 0) / 7;
    const imagesPerDay = last7.reduce((t, x) => t + x.images, 0) / 7;
    const gemini = await geminiStatus(n, settings, active.reduce((t, r) => t + r.imagesLeft, 0));
    const accounts = new Map();
    for (const r of active) {
      const a = accounts.get(r.ownerId || r.owner) || { owner: r.owner, stores: 0, credits: 0, imagesLeft: 0, used30: 0, perDay: 0, low: 0 };
      a.stores += 1; a.credits += r.credits; a.imagesLeft += r.imagesLeft; a.used30 += r.used30; a.perDay += r.perDay; a.low += r.low ? 1 : 0;
      accounts.set(r.ownerId || r.owner, a);
    }
    const accountRows = [...accounts.values()].map((a) => ({ ...a, credits: Math.round(a.credits * 100) / 100, perDay: Math.round(a.perDay * 10) / 10, daysLeft: a.perDay > 0 ? Math.round(a.imagesLeft / a.perDay * 10) / 10 : null })).sort((x, y) => y.credits - x.credits);
    const order = { daysLeft: (x, y) => (x.daysLeft ?? 1e9) - (y.daysLeft ?? 1e9) || x.imagesLeft - y.imagesLeft, credits: (x, y) => y.credits - x.credits, used: (x, y) => y.used30 - x.used30 };
    const listed = rows.filter((r) => r.billed && r.status === 'installed').sort(order[sort] || order.daysLeft);
    return {
      currency: settings.currency, costCurrency: settings.costCurrency, costPerImage: cost, settingCostPerImage: settings.aiCostPerImage, timezone: tz,
      totals: {
        stores: active.length, credits: sum('credits'), imagesLeft: sum('imagesLeft'), upcomingCost: Math.round(sum('imagesLeft') * cost * 100) / 100,
        used7: sum('used7'), used30: sum('used30'), imagesPerDay: Math.round(imagesPerDay * 10) / 10, costPerDay: Math.round(costPerDay * 100) / 100,
        aiCalls30: series.reduce((t, x) => t + x.aiCalls, 0), cost30: Math.round(series.reduce((t, x) => t + x.cost, 0) * 100) / 100,
        low: active.filter((r) => r.low && !r.empty).length, empty: active.filter((r) => r.empty).length,
        runOutIn7: active.filter((r) => r.daysLeft !== null && r.daysLeft <= 7).length,
      },
      series, gemini, tokens, accounts: accountRows, ...paginate(listed, page, pageSize, 100),
    };
  }

  // ---- checks ----
  async function checkStore(shop, n, state, settings) {
    const rec = await store.getShop(shop);
    if (!rec || rec.status === 'disconnected' || !isBilled(rec)) { delete state.shops[shop]; return null; }
    const s = creditSummary(settings, rec);
    const kind = s.empty ? 'empty' : s.low ? 'low' : null;
    if (!kind) { delete state.shops[shop]; return null; } // back above the line: the next drop alerts again
    if ((kind === 'low' && !n.alerts.storeLow) || (kind === 'empty' && !n.alerts.storeEmpty)) return null;
    const st = (state.shops[shop] ||= {});
    if (st[kind] && Date.now() - st[kind] < n.alerts.cooldownHours * H) return null;
    st[kind] = Date.now();
    const subject = kind === 'empty' ? `${shop} is out of lookOn credits` : `${shop} is low on lookOn credits`;
    const lines = kind === 'empty'
      ? [`${shop} has run out of credits. Try-ons are paused on its product pages until it buys more.`]
      : [`${shop} has ${s.imagesLeft} images left (${s.credits} credits). The warning level is ${settings.lowBalanceTryons} images.`];
    const r = await deliver(n, { kind: `store_${kind}`, subject, lines, link: { label: 'Open the control room', url: `${appUrl}/panel#usage` }, sms: `lookOn: ${kind === 'empty' ? `${shop} is OUT of credits, try-ons paused.` : `${shop} is low: ${s.imagesLeft} images left.`}` }, state);
    if (n.alerts.merchants && n.email.enabled) {
      const owner = rec.ownerId ? await store.getUser(rec.ownerId) : null;
      if (owner?.email && EMAIL_RE.test(owner.email)) {
        const mSubject = kind === 'empty' ? 'Your lookOn credits have run out' : 'Your lookOn credits are running low';
        const mLines = kind === 'empty' ? ['Your store has used all its lookOn credits, so the try-on block is paused on your product pages.', 'Buy a credit pack to switch it back on.'] : [`Your store has ${s.imagesLeft} try-on images left.`, 'Buy a credit pack so shoppers can keep trying products on.'];
        try { await sendEmail(n.email, env, { to: owner.email, subject: mSubject, text: [...mLines, `Buy credits: ${adminAppUrl(shop)}`].join('\n'), html: emailHtml(mSubject, mLines, { label: 'Buy credits', url: adminAppUrl(shop) }) }); r.merchant = true; }
        catch (e) { state.log.push({ at: Date.now(), kind: 'merchant_email', subject: mSubject, sent: 0, failed: [e.message] }); }
      }
    }
    return r;
  }

  async function checkGemini(n, state) {
    if (!n.alerts.geminiLow) return null;
    const settings = await getSettings();
    const g = await geminiStatus(n, settings);
    if (g.balance === null || !g.low) { state.gemini = {}; return null; }
    if (state.gemini.low && Date.now() - state.gemini.low < n.alerts.cooldownHours * H) return null;
    state.gemini.low = Date.now();
    const money = `${settings.costCurrency} ${g.left.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
    return deliver(n, { kind: 'gemini_low', subject: 'Gemini balance is running low',
      lines: [`Your Gemini prepay balance is about ${money}${g.imagesLeft !== null ? `, enough for about ${g.imagesLeft} images` : ''}${g.daysLeft !== null ? ` (${g.daysLeft} days at the current rate)` : ''}.`, 'When it reaches zero, every try-on fails. Add credit in AI Studio, then update the balance in the control room.'],
      link: { label: 'Add Gemini credit', url: n.gemini.billingUrl }, sms: `lookOn: Gemini balance about ${money}. Add credit: ${n.gemini.billingUrl}` }, state);
  }

  /** Right after a try-on: alert if this store just went low or out. Quick when there is nothing to send. */
  async function afterTryon(shop) {
    try {
      const n = await get();
      if (!n.email.enabled && !n.sms.enabled) return;
      const settings = await getSettings();
      const rec = await store.getShop(shop);
      const s = rec && creditSummary(settings, rec);
      const state = await getState();
      if (!s || (!s.low && !s.empty && !state.shops[shop])) return;
      const before = JSON.stringify(state);
      await checkStore(shop, n, state, settings);
      await checkGemini(n, state);
      if (JSON.stringify(state) !== before) await saveState(state);
    } catch (e) { console.warn('[alerts]', e.message); }
  }

  async function summary(n, state) {
    const r = await report({ pageSize: 10 });
    const y = r.series[r.series.length - 2] || { images: 0, aiCalls: 0, cost: 0 };
    const cc = (x) => `${r.costCurrency} ${Number(x).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
    const lines = [
      `Yesterday: ${y.images} images delivered, ${y.aiCalls} AI calls, about ${cc(y.cost)} on Gemini.`,
      `Stores hold ${r.totals.credits.toLocaleString('en-US')} credits (${r.totals.imagesLeft.toLocaleString('en-US')} images), about ${cc(r.totals.upcomingCost)} of Gemini cost still to come.`,
      `${r.totals.empty} stores out of credit, ${r.totals.low} running low, ${r.totals.runOutIn7} will run out within a week.`,
    ];
    if (r.gemini.balance !== null) lines.push(`Gemini balance: about ${cc(r.gemini.left)}${r.gemini.daysLeft !== null ? `, ${r.gemini.daysLeft} days at the current rate` : ''}.`);
    const soon = r.items.filter((x) => x.empty || (x.daysLeft !== null && x.daysLeft <= 7)).slice(0, 8);
    if (soon.length) lines.push('Running out soonest: ' + soon.map((x) => `${x.shop} (${x.empty ? 'out' : `${x.imagesLeft} images, ~${x.daysLeft} days`})`).join('; ') + '.');
    return deliver(n, { kind: 'daily_summary', subject: 'lookOn daily summary', lines, link: { label: 'Open usage', url: `${appUrl}/panel#usage` },
      sms: `lookOn yesterday: ${y.images} images. Stores hold ${r.totals.imagesLeft} images. ${r.totals.empty} out, ${r.totals.low} low.${r.gemini.balance !== null ? ` Gemini ~${cc(r.gemini.left)}.` : ''}` }, state);
  }

  /** The scheduler: called by Vercel Cron, an outside cron service, or "Run now". */
  async function run({ force = false, now = Date.now() } = {}) {
    const n = await get();
    const state = await getState();
    const done = { checked: false, summary: false, alerts: 0 };
    if (!n.schedule.enabled && !force) return { ...done, skipped: 'The scheduler is switched off.' };
    if (force || !state.lastCheckAt || now - state.lastCheckAt >= n.schedule.everyHours * H - 5 * 60_000) {
      const settings = await getSettings();
      for (const shop of await store.listShops()) if (await checkStore(shop, n, state, settings)) done.alerts += 1;
      if (await checkGemini(n, state)) done.alerts += 1;
      state.lastCheckAt = now; done.checked = true;
    }
    const local = localParts(now, n.schedule.timezone);
    const missed = state.lastSummaryAt && now - state.lastSummaryAt > 30 * H;
    if (n.alerts.dailySummary && state.lastSummaryDay !== local.day && (local.hour >= n.schedule.summaryHour || missed || force)) {
      if (n.email.enabled || n.sms.enabled) { await summary(n, state); done.summary = true; }
      state.lastSummaryDay = local.day; state.lastSummaryAt = now;
    }
    state.lastRunAt = now;
    await saveState(state);
    return done;
  }

  async function test(kind, to) {
    const n = await get();
    if (kind === 'email') {
      const target = to || n.alerts.emails[0];
      if (!target || !EMAIL_RE.test(target)) throw Object.assign(new Error('Add an alert email address first.'), { status: 400 });
      await sendEmail({ ...n.email, enabled: true }, env, { to: target, subject: 'lookOn test email', text: 'Email alerts from lookOn are working.', html: emailHtml('lookOn test email', ['Email alerts from lookOn are working.']) });
      return { to: target };
    }
    const target = to || n.alerts.phones[0];
    if (!target || !PHONE_RE.test(target)) throw Object.assign(new Error('Add an alert phone number first, e.g. +919876543210.'), { status: 400 });
    await sendSms({ ...n.sms, enabled: true }, env, f, { to: target, body: 'lookOn: alerts are working.' });
    return { to: target };
  }

  async function status() {
    const n = await get();
    const s = await getState();
    const next = s.lastCheckAt ? s.lastCheckAt + n.schedule.everyHours * H : null;
    return { lastRunAt: s.lastRunAt || null, lastCheckAt: s.lastCheckAt || null, lastSummaryAt: s.lastSummaryAt || null, nextCheckDue: next, log: (s.log || []).slice(-15).reverse(), watching: Object.keys(s.shops || {}).length };
  }

  async function gemini() { const settings = await getSettings(); return { ...(await geminiStatus(await get(), settings)), costCurrency: settings.costCurrency }; }
  return { get, recordAiCall, afterTryon, run, test, report, status, gemini };
}
