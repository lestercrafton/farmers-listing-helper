// The two AI calls: write a listing from photos, and research a compare-at price on the web.

import Anthropic from "@anthropic-ai/sdk";
import { HttpError } from "./http.js";
import {
  LISTING_SYSTEM, LISTING_SCHEMA, listingUserText,
  COMPARE_SYSTEM, COMPARE_SCHEMA, compareUserText,
} from "./prompts.js";
import { summarizeCompare } from "./pricing.js";

const MODEL = "claude-opus-5";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const MAX_SEARCHES = 6;
const MAX_CONTINUATIONS = 3;

function client(env) {
  if (!env.ANTHROPIC_API_KEY) {
    throw new HttpError(503, "not_configured", "The helper isn't fully set up yet (the AI key is missing).");
  }
  return new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    baseURL: env.ANTHROPIC_BASE_URL || undefined,
    maxRetries: 1,
    timeout: 150_000,
  });
}

// Refusal fallbacks let the API re-run a declined request on another model inside the same
// call. If the API ever rejects that option, ask again without it.
async function ask(anthropic, params) {
  try {
    return await anthropic.beta.messages.create({ ...params, betas: [FALLBACK_BETA], fallbacks: "default" });
  } catch (err) {
    if (err instanceof Anthropic.BadRequestError && /fallback|beta/i.test(err.message || "")) {
      return anthropic.messages.create(params);
    }
    throw err;
  }
}

function translate(err) {
  if (err instanceof HttpError) return err;
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    console.error("anthropic auth", err.status, err.message);
    return new HttpError(503, "not_configured", "The helper's AI key isn't working. Let Lester know.");
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new HttpError(503, "busy", "The AI is busy right now. Try again in a minute.");
  }
  if (err instanceof Anthropic.BadRequestError) {
    console.error("anthropic 400", err.message);
    if (/credit balance|billing/i.test(err.message || "")) {
      return new HttpError(503, "not_configured", "The helper's AI account is out of credit. Let Lester know.");
    }
    return new HttpError(502, "ai_rejected", "The AI couldn't work with that photo. Try a different picture.");
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new HttpError(504, "busy", "The AI took too long to answer. Please try again.");
  }
  if (err instanceof Anthropic.APIError) {
    console.error("anthropic", err.status, err.message);
    return new HttpError(503, "busy", "The AI service is having trouble right now. Try again in a minute.");
  }
  return err;
}

const image = (b64) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } });

function finalJson(message) {
  if (message.stop_reason === "refusal") {
    throw new HttpError(422, "refused", "The AI declined to work with this photo. Try a different picture.");
  }
  if (message.stop_reason === "max_tokens") {
    throw new HttpError(502, "ai_rejected", "The AI ran out of room before finishing. Please try again.");
  }
  const texts = message.content.filter((b) => b.type === "text").map((b) => b.text);
  const last = texts[texts.length - 1] || "";
  try {
    return JSON.parse(last);
  } catch {
    const m = last.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {}
    }
    console.error("unparseable model output", last.slice(0, 300));
    throw new HttpError(502, "ai_rejected", "The AI's answer came back garbled. Please try again.");
  }
}

function logUsage(route, started, message, extra = {}) {
  const u = message.usage || {};
  console.log(JSON.stringify({
    route, ms: Date.now() - started, model: message.model, stop: message.stop_reason,
    in: u.input_tokens, out: u.output_tokens, ...extra,
  }));
}

const str = (v, n) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");
const para = (v, n) => (typeof v === "string" ? v.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, n) : "");

export async function writeListing(env, { photos, style, notes, price, previous }) {
  const started = Date.now();
  try {
    const message = await ask(client(env), {
      model: MODEL,
      max_tokens: 16000,
      system: LISTING_SYSTEM,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: { type: "json_schema", schema: LISTING_SCHEMA } },
      messages: [{
        role: "user",
        content: [...photos.map(image), { type: "text", text: listingUserText({ style, notes, price, previous }) }],
      }],
    });
    const data = finalJson(message);
    logUsage("listing", started, message, { photos: photos.length });
    return {
      listing: {
        title: str(data.title, 120),
        description: para(data.description, 1500),
        social_post: para(data.social_post, 600),
        category: str(data.category, 60),
        brand: str(data.brand, 80),
        search_phrase: str(data.search_phrase, 160),
        check_before_posting: str(data.check_before_posting, 400),
      },
    };
  } catch (err) {
    throw translate(err);
  }
}

export async function comparePrices(env, { photo, title, description, brand, searchPhrase, notes, price }) {
  const started = Date.now();
  try {
    const anthropic = client(env);
    const content = [];
    if (photo) content.push(image(photo));
    content.push({ type: "text", text: compareUserText({ title, description, brand, searchPhrase, notes, price }) });
    const messages = [{ role: "user", content }];
    const params = {
      model: MODEL,
      max_tokens: 16000,
      system: COMPARE_SYSTEM,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: { type: "json_schema", schema: COMPARE_SCHEMA } },
      tools: [{
        type: "web_search_20260209",
        name: "web_search",
        max_uses: MAX_SEARCHES,
        user_location: { type: "approximate", city: "Memphis", region: "Tennessee", country: "US", timezone: "America/Chicago" },
      }],
      messages,
    };

    const searchedUrls = [];
    let searches = 0;
    let message;
    for (let turn = 0; ; turn++) {
      message = await ask(anthropic, params);
      for (const block of message.content) {
        if (block.type === "server_tool_use" && block.name === "web_search") searches++;
        if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
          for (const r of block.content) if (r?.type === "web_search_result" && r.url) searchedUrls.push(r.url);
        }
      }
      // A long server-tool turn can be handed back unfinished; send it back to continue.
      if (message.stop_reason !== "pause_turn" || turn >= MAX_CONTINUATIONS) break;
      messages.push({ role: "assistant", content: message.content });
    }
    if (message.stop_reason === "pause_turn") {
      throw new HttpError(504, "busy", "The price check took too long. Tap to try it again.");
    }

    const raw = finalJson(message);
    const compare = summarizeCompare(raw, { price, brandKnown: !!brand, searchedUrls });
    compare.checked_on = new Date().toLocaleDateString("en-US", {
      timeZone: "America/Chicago", month: "short", day: "numeric", year: "numeric",
    });
    logUsage("compare", started, message, {
      searches, found: compare.comps.length, used: compare.comps.filter((c) => c.used).length,
      suggested: compare.suggested, confidence: compare.confidence,
    });
    return { compare };
  } catch (err) {
    throw translate(err);
  }
}
