// Turns the comparables the model found into one compare-at number. The arithmetic is done here,
// in code, so the number is always traceable to prices that were actually found. The rules follow
// the FTC Guides Against Deceptive Pricing (16 CFR 233.2), which Tennessee's Consumer Protection
// Act is read alongside:
//   - "Compare at" is only for the identical item (same brand and style) at 2+ retailers.
//   - "Comparable value" is for similar items of like quality at 3+ retailers, and must say so.
//   - The number must not exceed what retailers are actually charging: one current price per
//     retailer, outliers dropped, the lower median, rounded down. Never the highest price.
//   - A comparable only counts if its link points at a site that really came back from search.
// The thresholds are deliberate, conservative choices, not numbers taken from the rule.

import { MARKETS } from "./prompts.js";

const EXCLUDED_HOSTS = [
  "ebay.", "poshmark.", "mercari.", "temu.", "aliexpress.", "alibaba.", "shein.", "wish.com", "dhgate.",
  "faire.com", "facebook.com", "pinterest.", "depop.", "thredup.", "offerup.", "craigslist.", "etsy.",
];

export function hostOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return "";
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

const clean = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const lowerMedian = (sorted) => sorted[Math.floor((sorted.length - 1) / 2)];

export function roundDown(p) {
  if (p < 100) return Math.floor(p);
  if (p < 500) return Math.floor(p / 5) * 5;
  return Math.floor(p / 10) * 10;
}

// One data point per retailer: the lowest price a shopper pays there today.
function perRetailer(list) {
  const best = new Map();
  for (const c of list) {
    const k = c.host || c.retailer.toLowerCase();
    if (!best.has(k) || c.price < best.get(k).price) best.set(k, c);
  }
  return [...best.values()].sort((a, b) => a.price - b.price);
}

/**
 * @param raw           parsed model output (COMPARE_SCHEMA)
 * @param price         the store's own price, or null
 * @param brandKnown    true when the brand came from a tag, label or the owner's notes
 * @param searchedUrls  every URL that appeared in a web search result during the research
 */
export function summarizeCompare(raw, { price = null, brandKnown = false, searchedUrls = [] } = {}) {
  const seenHosts = new Set(searchedUrls.map(hostOf).filter(Boolean));
  const seenUrls = new Set(searchedUrls);

  const comps = [];
  const dedupe = new Set();
  for (const c of Array.isArray(raw?.comparables) ? raw.comparables : []) {
    const p = Number(c?.price);
    if (!Number.isFinite(p) || p <= 0 || p > 100000) continue;
    const host = hostOf(c.url);
    if (host && EXCLUDED_HOSTS.some((h) => host.includes(h))) continue;
    // A link is only kept when web search really returned that site. Otherwise the comparable
    // is shown without a link and never used in the number.
    const verified = !!host && (seenUrls.has(c.url) || seenHosts.has(host));
    const key = `${host}|${Math.round(p * 100)}|${clean(c.item, 60).toLowerCase()}`;
    if (dedupe.has(key)) continue;
    dedupe.add(key);
    const priceType = ["sale", "clearance"].includes(c.price_type) ? c.price_type : "regular";
    comps.push({
      retailer: clean(c.retailer, 60) || host,
      item: clean(c.item, 140),
      price: Math.round(p * 100) / 100,
      price_type: priceType,
      // Without a brand from the tag or the owner, nothing can honestly be called identical.
      match: c.match === "same" && brandKnown ? "same" : "similar",
      market: MARKETS.includes(c.market) ? c.market : "National",
      url: verified ? c.url : "",
      host: verified ? host : "",
      verified,
      used: false,
    });
  }

  const result = {
    suggested: null,
    wording: "",
    basis: "none",
    confidence: "none",
    reason: "",
    identified_as: clean(raw?.identified_as, 120),
    item_type: clean(raw?.item_type, 60),
    note: clean(raw?.research_note, 400),
    comps,
  };
  const decline = (reason) => {
    result.reason = reason;
    return result;
  };

  const usable = comps.filter((c) => c.verified && c.price_type !== "clearance");
  const same = perRetailer(usable.filter((c) => c.match === "same"));
  let pts, basis, minNeeded;
  if (same.length >= 2) {
    [pts, basis, minNeeded] = [same, "same", 2];
  } else {
    [pts, basis, minNeeded] = [perRetailer(usable), "similar", 3];
  }
  if (pts.length < minNeeded) {
    return decline(usable.length
      ? `Only found ${pts.length} store${pts.length === 1 ? "" : "s"} with a price for this, which isn't enough to back up a compare-at price.`
      : "Couldn't find this item, or anything close enough to it, with a published price at other stores.");
  }

  // Drop prices far from the middle (usually a different product slipped in).
  const m0 = lowerMedian(pts.map((c) => c.price));
  pts = pts.filter((c) => c.price <= m0 * 1.5 && c.price >= m0 * 0.5);
  if (pts.length < minNeeded) return decline("The prices found were too far apart to back up a compare-at price.");

  const prices = pts.map((c) => c.price);
  const spread = prices[prices.length - 1] / prices[0];
  if (spread > 2) return decline("The prices found were too far apart to back up a compare-at price.");

  pts.forEach((c) => (c.used = true));
  result.basis = basis;
  result.wording = basis === "same" ? "Compare at" : "Comparable value";
  result.stores = pts.length;
  result.low = prices[0];
  result.high = prices[prices.length - 1];

  const saleShare = pts.filter((c) => c.price_type === "sale").length / pts.length;
  if (basis === "same") {
    result.confidence = pts.length >= 3 && spread <= 1.25 && saleShare < 0.5 ? "high" : "medium";
    if (saleShare >= 0.5 || spread > 1.6) result.confidence = "low";
  } else {
    result.confidence = spread <= 1.4 && saleShare < 0.5 ? "medium" : "low";
  }

  // The lower median: at least half of these stores charge this much or more.
  const suggested = roundDown(lowerMedian(prices));
  result.typical = suggested;
  if (suggested < 1) return decline("The prices found were too low to suggest a compare-at price.");
  // A tiny difference isn't worth a comparison claim.
  if (price && !(suggested >= price * 1.1 && suggested - price >= 2)) {
    return decline("Your price is already in line with what this sells for elsewhere, so a compare-at price wouldn't help.");
  }
  result.suggested = suggested;
  return result;
}
