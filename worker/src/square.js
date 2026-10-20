// Square: connect the store's account once (OAuth, catalog permissions only), then push finished
// listings into the Square item library as new items.
//
// Everything here is switched off until three secrets exist: SQUARE_APP_ID, SQUARE_APP_SECRET and
// STORE_PIN. The PIN is what stops a stranger with the public link from connecting their own
// Square account or adding items to the store's.

import { Buffer } from "node:buffer";
import {
  HttpError, json, readForm, photos, text, money, enforceLimits, today,
} from "./http.js";

const SQUARE_VERSION = "2025-10-16";
const SCOPES = "ITEMS_READ ITEMS_WRITE MERCHANT_PROFILE_READ";
const TOKENS_KEY = "square:tokens";
const MIN_PIN_LENGTH = 6;
const MAX_PIN_FAILURES_PER_DAY = 30;
const REFRESH_WHEN_UNDER_MS = 8 * 24 * 60 * 60 * 1000; // access tokens last 30 days

const base = (env) => (env.SQUARE_ENV === "sandbox" ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com");
const configured = (env) =>
  !!(env.KV && env.SQUARE_APP_ID && env.SQUARE_APP_SECRET && env.STORE_PIN && env.STORE_PIN.length >= MIN_PIN_LENGTH);
const redirectUri = (url) => `${url.origin}/api/square/callback`;
const appUrl = (env) => env.APP_URL || "https://lestercrafton.github.io/farmers-listing-helper/";

async function loadTokens(env) {
  if (!env.KV) return null;
  return await env.KV.get(TOKENS_KEY, "json");
}

export async function squareStatus(env) {
  if (!configured(env)) return { available: false, connected: false, merchant: "" };
  const t = await loadTokens(env);
  return { available: true, connected: !!t?.access_token, merchant: t?.merchant_name || "" };
}

// ---------- PIN ----------

async function digest(s) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

async function requirePin(request, env) {
  await enforceLimits(request, env, "PIN_LIMITER");
  const failKey = `pinfail:${today()}`;
  const fails = parseInt((await env.KV.get(failKey)) || "0", 10) || 0;
  if (fails >= MAX_PIN_FAILURES_PER_DAY) {
    throw new HttpError(429, "locked", "Too many wrong PINs today. Square sending is locked until tomorrow.");
  }
  const given = request.headers.get("X-Store-Pin") || "";
  // Compare hashes so the comparison takes the same time whatever was typed.
  const [a, b] = await Promise.all([digest(given), digest(env.STORE_PIN)]);
  if (!crypto.subtle.timingSafeEqual(a, b)) {
    await env.KV.put(failKey, String(fails + 1), { expirationTtl: 60 * 60 * 48 });
    throw new HttpError(401, "bad_pin", "That PIN didn't match.");
  }
}

// ---------- Square HTTP ----------

function squareError(status, body) {
  const first = body?.errors?.[0];
  const detail = first?.detail || first?.code || body?.message || `HTTP ${status}`;
  console.error("square", status, JSON.stringify(body?.errors || body || "").slice(0, 500));
  if (status === 401 || first?.category === "AUTHENTICATION_ERROR") {
    return new HttpError(502, "square_auth", "Square says the connection has expired. Connect your Square store again.");
  }
  if (status === 429) return new HttpError(503, "busy", "Square is busy right now. Try again in a minute.");
  return new HttpError(502, "square_error", `Square didn't accept that: ${String(detail).slice(0, 200)}`);
}

async function squareFetch(env, path, { token, body, form, method = "POST", clientAuth = false } = {}) {
  const headers = { "Square-Version": SQUARE_VERSION, Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (clientAuth) headers.Authorization = `Client ${env.SQUARE_APP_SECRET}`;
  if (body) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(base(env) + path, { method, headers, body: form || (body ? JSON.stringify(body) : undefined) });
  } catch {
    throw new HttpError(504, "busy", "Couldn't reach Square. Please try again.");
  }
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok || data?.errors?.length) throw squareError(res.status, data);
  return data || {};
}

async function saveTokens(env, tok, extra = {}) {
  const prev = (await loadTokens(env)) || {};
  const next = {
    ...prev,
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || prev.refresh_token,
    expires_at: tok.expires_at,
    merchant_id: tok.merchant_id || prev.merchant_id,
    ...extra,
  };
  await env.KV.put(TOKENS_KEY, JSON.stringify(next));
  return next;
}

async function freshTokens(env) {
  let t = await loadTokens(env);
  if (!t?.access_token) throw new HttpError(409, "square_not_connected", "Connect your Square store first.");
  const left = Date.parse(t.expires_at || "") - Date.now();
  if (Number.isFinite(left) && left < REFRESH_WHEN_UNDER_MS && t.refresh_token) {
    try {
      const tok = await squareFetch(env, "/oauth2/token", {
        body: {
          client_id: env.SQUARE_APP_ID, client_secret: env.SQUARE_APP_SECRET,
          grant_type: "refresh_token", refresh_token: t.refresh_token,
        },
      });
      t = await saveTokens(env, tok);
    } catch (err) {
      if (left <= 0) throw new HttpError(502, "square_auth", "The Square connection has expired. Connect your Square store again.");
      console.error("square refresh failed, using current token", err?.message);
    }
  }
  return t;
}

// ---------- routes ----------

async function connect(request, env, url, cors) {
  await requirePin(request, env);
  const state = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await env.KV.put(`sqstate:${state}`, "1", { expirationTtl: 600 });
  const q = new URLSearchParams({
    client_id: env.SQUARE_APP_ID,
    scope: SCOPES,
    session: "false",
    state,
    redirect_uri: redirectUri(url),
  });
  return json({ ok: true, url: `${base(env)}/oauth2/authorize?${q}` }, 200, cors);
}

function backToApp(env, outcome, why = "") {
  const hash = outcome === "connected" ? "#square=connected" : `#square=error&why=${encodeURIComponent(why)}`;
  return Response.redirect(appUrl(env) + hash, 302);
}

async function callback(env, url) {
  if (!configured(env)) return backToApp(env, "error", "Square is not set up");
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  const denied = url.searchParams.get("error");
  if (!/^[0-9a-f]{48}$/.test(state) || !(await env.KV.get(`sqstate:${state}`))) {
    return backToApp(env, "error", "the sign-in link expired");
  }
  await env.KV.delete(`sqstate:${state}`);
  if (denied || !code) return backToApp(env, "error", denied === "access_denied" ? "access was not approved" : "Square did not finish signing in");
  try {
    const tok = await squareFetch(env, "/oauth2/token", {
      body: {
        client_id: env.SQUARE_APP_ID, client_secret: env.SQUARE_APP_SECRET,
        grant_type: "authorization_code", code, redirect_uri: redirectUri(url),
      },
    });
    let merchantName = "";
    try {
      const m = await squareFetch(env, "/v2/merchants/me", { token: tok.access_token, method: "GET" });
      merchantName = text(m?.merchant?.business_name || "", 80);
    } catch {}
    await saveTokens(env, tok, { merchant_name: merchantName, connected_at: new Date().toISOString() });
    return backToApp(env, "connected");
  } catch (err) {
    console.error("square callback", err?.message);
    return backToApp(env, "error", "Square did not accept the sign-in");
  }
}

async function disconnect(request, env, cors) {
  await requirePin(request, env);
  const t = await loadTokens(env);
  if (t?.access_token) {
    try {
      await squareFetch(env, "/oauth2/revoke", { clientAuth: true, body: { client_id: env.SQUARE_APP_ID, access_token: t.access_token } });
    } catch (err) {
      console.error("square revoke", err?.message);
    }
  }
  await env.KV.delete(TOKENS_KEY);
  return json({ ok: true }, 200, cors);
}

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const toHtml = (s) => s.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("");

async function hex(s, n) {
  return [...(await digest(s))].slice(0, n).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function createItem(request, env, cors) {
  await requirePin(request, env);
  const form = await readForm(request);
  const title = text(form.get("title"), 255);
  const description = text(form.get("description"), 4000);
  const price = money(form.get("price"));
  const pics = photos(form, { min: 0 });
  const listingId = text(form.get("id"), 40).replace(/[^\w-]/g, "");
  if (!title) throw new HttpError(400, "bad_request", "The listing needs an item name.");
  if (!price) throw new HttpError(400, "bad_request", "Add your price first.");

  const t = await freshTokens(env);
  // Sending the very same listing twice returns the first item instead of making a duplicate.
  const key = `flh-${listingId || "x"}-${await hex(`${title}|${description}|${price}`, 12)}`;
  const upsert = await squareFetch(env, "/v2/catalog/object", {
    token: t.access_token,
    body: {
      idempotency_key: key,
      object: {
        type: "ITEM",
        id: "#item",
        present_at_all_locations: true,
        item_data: {
          name: title,
          description_html: toHtml(description),
          product_type: "REGULAR",
          variations: [{
            type: "ITEM_VARIATION",
            id: "#variation",
            present_at_all_locations: true,
            item_variation_data: {
              item_id: "#item",
              name: "Regular",
              pricing_type: "FIXED_PRICING",
              price_money: { amount: Math.round(price * 100), currency: "USD" },
            },
          }],
        },
      },
    },
  });
  const itemId = upsert?.catalog_object?.id;
  if (!itemId) throw new HttpError(502, "square_error", "Square didn't confirm the new item. Check your item library before sending again.");

  let added = 0;
  for (let i = 0; i < pics.length; i++) {
    try {
      const fd = new FormData();
      fd.append("request", new Blob([JSON.stringify({
        idempotency_key: `${key}-img${i}`,
        object_id: itemId,
        is_primary: i === 0,
        image: { type: "IMAGE", id: `#image${i}`, image_data: { name: title.slice(0, 100), caption: title.slice(0, 100) } },
      })], { type: "application/json" }));
      fd.append("file", new Blob([Buffer.from(pics[i], "base64")], { type: "image/jpeg" }), `photo-${i + 1}.jpg`);
      await squareFetch(env, "/v2/catalog/images", { token: t.access_token, form: fd });
      added++;
    } catch (err) {
      console.error("square image", i, err?.message);
    }
  }
  console.log(JSON.stringify({ route: "square_item", item: itemId, photos: pics.length, added }));
  return json({ ok: true, item_id: itemId, photos_added: added }, 200, cors);
}

export async function handleSquare(request, env, ctx, url, cors) {
  if (url.pathname === "/api/square/callback" && request.method === "GET") return callback(env, url);
  if (!configured(env)) throw new HttpError(404, "square_off", "Square isn't set up for this helper yet.");
  if (request.method === "POST") {
    if (url.pathname === "/api/square/connect") return connect(request, env, url, cors);
    if (url.pathname === "/api/square/item") return createItem(request, env, cors);
    if (url.pathname === "/api/square/disconnect") return disconnect(request, env, cors);
  }
  throw new HttpError(404, "not_found", "Not found.");
}
