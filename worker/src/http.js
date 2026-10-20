// Small HTTP helpers shared by the routes: CORS, JSON replies, input cleaning, abuse limits.

export const DEFAULT_ORIGIN = "https://lestercrafton.github.io";
export const MAX_PHOTOS = 4;
export const MAX_PHOTO_CHARS = 1_400_000; // about 1 MB of JPEG once base64-encoded
export const MAX_BODY_BYTES = 6_500_000;

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const LOCALHOST = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function allowedOrigin(request, env) {
  const origin = request.headers.get("Origin") || "";
  if (!origin) return "";
  const list = (env.ALLOWED_ORIGINS || DEFAULT_ORIGIN).split(",").map((s) => s.trim()).filter(Boolean);
  if (list.includes(origin) || LOCALHOST.test(origin)) return origin;
  return "";
}

export function corsHeaders(origin) {
  const h = { Vary: "Origin" };
  if (origin) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    h["Access-Control-Allow-Headers"] = "Content-Type, X-Store-Pin";
    h["Access-Control-Max-Age"] = "86400";
  }
  return h;
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

export function fail(err, headers = {}) {
  const status = err instanceof HttpError ? err.status : 500;
  const code = err instanceof HttpError ? err.code : "server_error";
  const message = err instanceof HttpError ? err.message : "Something went wrong on the server. Please try again.";
  if (!(err instanceof HttpError)) console.error("unhandled", err?.stack || String(err));
  return json({ ok: false, error: { code, message } }, status, headers);
}

// A slow AI call can outlast idle-connection timeouts. This answers right away with a streamed
// body: a space every few seconds while the work runs, then the JSON. Leading whitespace is
// legal JSON, so the browser can still just call response.json().
export function streamJson(ctx, headers, work) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const beat = setInterval(() => writer.write(enc.encode(" ")).catch(() => {}), 8000);
  const done = (async () => {
    let payload;
    try {
      payload = { ok: true, ...(await work()) };
    } catch (err) {
      const known = err instanceof HttpError;
      if (!known) console.error("unhandled", err?.stack || String(err));
      payload = {
        ok: false,
        error: {
          code: known ? err.code : "server_error",
          message: known ? err.message : "Something went wrong on the server. Please try again.",
        },
      };
    } finally {
      clearInterval(beat);
    }
    try {
      await writer.write(enc.encode(JSON.stringify(payload)));
      await writer.close();
    } catch {
      // The browser went away; nothing to deliver.
    }
  })();
  ctx.waitUntil(done);
  return new Response(readable, {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

// ---------- input cleaning ----------

export const text = (v, max) => (typeof v === "string" ? v.replace(/\u0000/g, "").trim().slice(0, max) : "");

export function money(v) {
  if (typeof v !== "string" || !v.trim()) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 100000) return null;
  return Math.round(n * 100) / 100;
}

export function oneOf(v, allowed, fallback) {
  return allowed.includes(v) ? v : fallback;
}

export async function readForm(request) {
  const len = Number(request.headers.get("Content-Length") || 0);
  if (len > MAX_BODY_BYTES) throw new HttpError(413, "too_large", "Those photos are too large. Try fewer photos.");
  const type = request.headers.get("Content-Type") || "";
  if (!type.includes("multipart/form-data")) throw new HttpError(400, "bad_request", "Unexpected request format.");
  try {
    return await request.formData();
  } catch {
    throw new HttpError(400, "bad_request", "Could not read the upload. Please try again.");
  }
}

// Photos arrive as base64 JPEG text fields. Checking the alphabet means the string can be
// passed straight through without ever being decoded here.
export function photos(form, { min = 1, max = MAX_PHOTOS } = {}) {
  const out = [];
  for (const v of form.getAll("photo")) {
    if (typeof v !== "string" || !v) continue;
    if (v.length > MAX_PHOTO_CHARS) throw new HttpError(413, "too_large", "One of the photos is too large.");
    if (v.length < 200 || !B64.test(v) || !v.startsWith("/9j/")) {
      throw new HttpError(400, "bad_photo", "One of the photos could not be read. Try taking it again.");
    }
    out.push(v);
    if (out.length > max) throw new HttpError(400, "too_many", `Please use ${max} photos or fewer.`);
  }
  if (out.length < min) throw new HttpError(400, "no_photo", "Add at least one photo.");
  return out;
}

// ---------- abuse limits ----------

export function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

export async function enforceLimits(request, env, limiter = "RATE_LIMITER") {
  const rl = env[limiter];
  if (rl?.limit) {
    const { success } = await rl.limit({ key: clientIp(request) });
    if (!success) throw new HttpError(429, "slow_down", "That was a lot of requests in a row. Wait a minute and try again.");
  }
}

export function today() {
  // The store's day, not UTC.
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

// A soft daily ceiling on AI calls so a shared link cannot run up a large bill. The hard limit
// is the spend limit on the Anthropic workspace; this is the friendly one in front of it.
export async function countAgainstDailyCap(env) {
  if (!env.KV) return;
  const limit = parseInt(env.DAILY_LIMIT || "300", 10);
  const key = `count:${today()}`;
  const used = parseInt((await env.KV.get(key)) || "0", 10) || 0;
  if (used >= limit) {
    throw new HttpError(429, "daily_limit", "The helper has reached its limit for today. It resets overnight.");
  }
  await env.KV.put(key, String(used + 1), { expirationTtl: 60 * 60 * 72 });
}
