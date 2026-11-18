// Google Gemini image model (Nano Banana). Accepts several images, so the shopper's photo and the product photo go together.
import { TryOnError } from '../errors.js';

function pickImage(json) {
  let image = null;
  const texts = [];
  for (const step of json.steps || []) {
    if (step.type !== 'model_output') continue;
    for (const block of step.content || []) {
      if (block.type === 'image' && block.data) image = block;
      if (block.type === 'text' && block.text) texts.push(block.text);
    }
  }
  if (!image && json.output_image?.data) image = json.output_image;
  return { image, text: texts.join(' ').trim() };
}

/** Token counts Gemini reports for one call (Interactions API "usage", or the older "usageMetadata"). */
export function readUsage(json, hasImage = true) {
  const u = json?.usage || json?.usageMetadata;
  if (!u) return null;
  const num = (...v) => { for (const x of v) if (Number.isFinite(Number(x))) return Number(x); return 0; };
  const input = num(u.total_input_tokens, u.promptTokenCount);
  const output = num(u.total_output_tokens, u.candidatesTokenCount);
  const thought = num(u.total_thought_tokens, u.thoughtsTokenCount);
  const mods = u.output_tokens_by_modality || u.candidatesTokensDetails || [];
  const imageMod = mods.filter((m) => String(m.modality).toLowerCase() === 'image').reduce((t, m) => t + num(m.tokens, m.tokenCount), 0);
  // Without a per-modality split, an answer that carries a picture is billed as image output.
  const image = mods.length ? imageMod : hasImage ? output : 0;
  return { model: json.model || null, input, output, image, text: Math.max(0, output - image), thought, total: num(u.total_tokens, u.totalTokenCount, input + output + thought) };
}

export const gemini = {
  id: 'gemini',
  maxPersonSide: 1536, // the shopper's photo can be large; Gemini keeps far more detail than Cloudflare
  productSide: 1024,
  ready: (env) => Boolean(env.GEMINI_API_KEY),
  async generate({ env, fetch: f, prompt, person, product, signal }) {
    const base = env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
    const body = {
      model: env.GEMINI_MODEL || 'gemini-nano-banana-2.1',
      input: [
        { type: 'text', text: prompt },
        { type: 'image', mime_type: person.mime, data: person.data },
        { type: 'image', mime_type: product.mime, data: product.data },
      ],
      response_format: { type: 'image', image_size: env.GEMINI_IMAGE_SIZE || '1K' },
    };
    let res;
    try {
      res = await f(`${base}/v1beta/interactions`, { method: 'POST', headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') throw new TryOnError('The preview took too long. Please try again.', 504);
      throw new TryOnError('We could not create your preview just now. Please try again.', 502);
    }
    const raw = await res.text();
    let json = {};
    try { json = JSON.parse(raw); } catch { /* non-JSON error body */ }
    if (!res.ok) {
      console.error(`[gemini] ${res.status} ${json?.error?.message || raw.slice(0, 200)}`);
      if (res.status === 429) throw new TryOnError('Try-on is very busy right now. Please try again in a minute.', 429);
      if (res.status === 400) throw new TryOnError('We could not use this photo. Please try a clear, well-lit, front-facing photo.', 422);
      if (res.status === 401 || res.status === 403) throw new TryOnError('Try-on is temporarily unavailable. Please try again later.', 503); // key rejected: see server log
      throw new TryOnError('We could not create your preview just now. Please try again.', 502);
    }
    const { image, text } = pickImage(json);
    const usage = readUsage(json, Boolean(image));
    if (!image) {
      if (text) console.warn('[engine] no image:', String(text).slice(0, 300));
      throw Object.assign(new TryOnError('No preview was made this time. Please try a clearer, front-facing photo.', 422), { usage }); // Google still bills the tokens
    }
    return { mime: image.mime_type || 'image/png', data: image.data, usage };
  },
};
