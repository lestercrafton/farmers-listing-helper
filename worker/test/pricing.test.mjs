import test from "node:test";
import assert from "node:assert/strict";
import { summarizeCompare, roundDown } from "../src/pricing.js";

let n = 0;
const comp = (o) => ({ retailer: "R" + n, item: "Thing " + n++, price: 10, price_type: "regular", match: "similar", market: "National", url: "https://a.com/x", ...o });
const urls = ["https://a.com/x", "https://b.com/y", "https://c.com/z", "https://d.com/q", "https://e.com/r"];

test("similar items: lower median, rounded down, 'Comparable value'", () => {
  const r = summarizeCompare({ comparables: [comp({ price: 60.5, url: urls[0] }), comp({ price: 69.5, url: urls[1] }), comp({ price: 79, url: urls[2] })] }, { price: 39, searchedUrls: urls });
  assert.equal(r.suggested, 69);
  assert.equal(r.wording, "Comparable value");
  assert.equal(r.basis, "similar");
  assert.equal(r.stores, 3);
});

test("two similar stores are not enough", () => {
  const r = summarizeCompare({ comparables: [comp({ price: 60, url: urls[0] }), comp({ price: 70, url: urls[1] })] }, { searchedUrls: urls });
  assert.equal(r.suggested, null);
  assert.match(r.reason, /isn't enough/);
});

test("identical items need a known brand, then 2 stores are enough and say 'Compare at'", () => {
  const raw = { comparables: [comp({ price: 48, match: "same", url: urls[0] }), comp({ price: 52, match: "same", url: urls[1] })] };
  const withBrand = summarizeCompare(raw, { price: 30, brandKnown: true, searchedUrls: urls });
  assert.equal(withBrand.wording, "Compare at");
  assert.equal(withBrand.suggested, 48); // lower median of two is the lower price
  const noBrand = summarizeCompare(raw, { price: 30, brandKnown: false, searchedUrls: urls });
  assert.equal(noBrand.suggested, null); // only 2 "similar" stores
  assert.ok(noBrand.comps.every((c) => c.match === "similar"));
});

test("one price per store, the lowest", () => {
  const r = summarizeCompare({ comparables: [
    comp({ price: 90, url: "https://a.com/1" }), comp({ price: 60, url: "https://a.com/2" }),
    comp({ price: 62, url: urls[1] }), comp({ price: 64, url: urls[2] }),
  ] }, { searchedUrls: [...urls, "https://a.com/1", "https://a.com/2"] });
  assert.equal(r.stores, 3);
  assert.equal(r.suggested, 62);
});

test("links that never appeared in search results are not counted or linked", () => {
  const r = summarizeCompare({ comparables: [
    comp({ price: 500, url: "https://made-up.example/1" }), comp({ price: 60, url: urls[0] }), comp({ price: 62, url: urls[1] }), comp({ price: 64, url: urls[2] }),
  ] }, { searchedUrls: urls });
  const fake = r.comps.find((c) => c.price === 500);
  assert.equal(fake.verified, false);
  assert.equal(fake.url, "");
  assert.equal(fake.used, false);
  assert.equal(r.suggested, 62);
});

test("resale, marketplace and clearance prices are not used", () => {
  const r = summarizeCompare({ comparables: [
    comp({ url: "https://www.ebay.com/itm/1" }), comp({ url: "https://poshmark.com/x" }), comp({ url: "https://www.etsy.com/l/1" }),
    comp({ price: 5, price_type: "clearance", url: urls[0] }),
  ] }, { searchedUrls: ["https://www.ebay.com/itm/1", "https://poshmark.com/x", "https://www.etsy.com/l/1", ...urls] });
  assert.equal(r.comps.length, 1);
  assert.equal(r.suggested, null);
});

test("outliers dropped; scattered prices declined", () => {
  const ok = summarizeCompare({ comparables: [
    comp({ price: 50, url: urls[0] }), comp({ price: 54, url: urls[1] }), comp({ price: 58, url: urls[2] }), comp({ price: 400, url: urls[3] }),
  ] }, { searchedUrls: urls });
  assert.equal(ok.suggested, 54);
  assert.equal(ok.comps.find((c) => c.price === 400).used, false);
  const scattered = summarizeCompare({ comparables: [
    comp({ price: 30, url: urls[0] }), comp({ price: 45, url: urls[1] }), comp({ price: 55, url: urls[2] }), comp({ price: 62, url: urls[3] }),
  ] }, { searchedUrls: urls });
  assert.equal(scattered.suggested, null);
  assert.match(scattered.reason, /too far apart/);
});

test("no suggestion unless clearly above the store's price", () => {
  const r = summarizeCompare({ comparables: [comp({ price: 26, url: urls[0] }), comp({ price: 27, url: urls[1] }), comp({ price: 28, url: urls[2] })] }, { price: 24.99, searchedUrls: urls });
  assert.equal(r.suggested, null);
  assert.equal(r.typical, 27);
  assert.match(r.reason, /in line/);
});

test("rounding is always down", () => {
  assert.equal(roundDown(69.99), 69);
  assert.equal(roundDown(249), 245);
  assert.equal(roundDown(1288), 1280);
});

test("garbage in, nothing out", () => {
  for (const raw of [null, {}, { comparables: "no" }, { comparables: [{ price: "abc" }, { price: -5 }, null] }]) {
    const r = summarizeCompare(raw, {});
    assert.equal(r.suggested, null);
    assert.deepEqual(r.comps, []);
  }
});

test("javascript: and other non-web links are never passed through", () => {
  const r = summarizeCompare({ comparables: [comp({ url: "javascript:alert(1)" })] }, { searchedUrls: ["javascript:alert(1)"] });
  assert.equal(r.comps[0].url, "");
  assert.equal(r.comps[0].verified, false);
});
