// Farmers Listing Helper API.
// The public page (GitHub Pages) posts photos here; this Worker holds the AI key, writes the
// listing, researches a compare-at price, and can push a finished listing into Square.

import {
  HttpError, allowedOrigin, corsHeaders, json, fail, streamJson, readForm, photos,
  text, money, oneOf, enforceLimits, countAgainstDailyCap, MAX_PHOTOS,
} from "./http.js";
import { writeListing, comparePrices } from "./ai.js";
import { squareStatus, handleSquare } from "./square.js";

const STYLES = ["classic", "better", "warm"];

function previousVersions(form) {
  try {
    const list = JSON.parse(form.get("previous") || "[]");
    if (!Array.isArray(list)) return [];
    return list.filter((s) => typeof s === "string").slice(-4).map((s) => text(s, 1200)).filter(Boolean);
  } catch {
    return [];
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = allowedOrigin(request, env);
    const cors = corsHeaders(origin);

    try {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

      if (url.pathname === "/" && request.method === "GET") {
        return new Response("Farmers Listing Helper API", { headers: { "Content-Type": "text/plain" } });
      }

      // The Square sign-in comes back as a plain page navigation, so it has no Origin to check.
      if (url.pathname === "/api/square/callback" && request.method === "GET") {
        return await handleSquare(request, env, ctx, url, cors);
      }

      // Everything else is called by the page's own JavaScript and must come from it.
      if (!origin) throw new HttpError(403, "forbidden", "This API only answers the Farmers Listing Helper page.");

      if (url.pathname === "/api/config" && request.method === "GET") {
        return json({
          ok: true,
          ai: !!env.ANTHROPIC_API_KEY,
          max_photos: MAX_PHOTOS,
          square: await squareStatus(env),
        }, 200, cors);
      }

      if (url.pathname === "/api/listing" && request.method === "POST") {
        await enforceLimits(request, env);
        const form = await readForm(request);
        const input = {
          photos: photos(form),
          style: oneOf(form.get("style"), STYLES, "better"),
          notes: text(form.get("notes"), 600),
          price: money(form.get("price")),
          previous: previousVersions(form),
        };
        await countAgainstDailyCap(env);
        return streamJson(ctx, cors, () => writeListing(env, input));
      }

      if (url.pathname === "/api/compare" && request.method === "POST") {
        await enforceLimits(request, env);
        const form = await readForm(request);
        const input = {
          photo: photos(form, { min: 0, max: 1 })[0] || null,
          title: text(form.get("title"), 160),
          description: text(form.get("description"), 1500),
          brand: text(form.get("brand"), 80),
          searchPhrase: text(form.get("search_phrase"), 160),
          notes: text(form.get("notes"), 600),
          price: money(form.get("price")),
        };
        if (!input.title && !input.description) throw new HttpError(400, "bad_request", "Nothing to look up yet.");
        await countAgainstDailyCap(env);
        return streamJson(ctx, cors, () => comparePrices(env, input));
      }

      if (url.pathname.startsWith("/api/square/")) {
        return await handleSquare(request, env, ctx, url, cors);
      }

      throw new HttpError(404, "not_found", "Not found.");
    } catch (err) {
      return fail(err, cors);
    }
  },
};
