# Farmers Listing Helper

Snap a photo of an item and get a store-ready listing for Farmers Hardware & Home Furnishings
(Somerville, TN): an item name in the store's house style, a description, a Facebook/Instagram post,
and a compare-at price found by searching what other stores charge.

**Link to share:** https://lestercrafton.github.io/farmers-listing-helper/

## How it fits together

- `index.html` is the whole page, hosted on GitHub Pages. No sign-in, no key on the phone.
- `worker/` is a Cloudflare Worker (`farmers-listing-helper`, https://farmers-listing-helper.sitetime.workers.dev)
  that holds the Anthropic API key and makes the AI calls with `claude-opus-5`:
  - `POST /api/listing`: photos to item name, description, social post.
  - `POST /api/compare`: web search for the same or similar items; `src/pricing.js` works out the number.
  - `/api/square/*`: optional "Send to my Square store" (off until the Square secrets below are set).
- Only the GitHub Pages origin may call the API. 12 AI calls a minute per visitor, 300 a day overall
  (`DAILY_LIMIT` in `worker/wrangler.jsonc`). Put a monthly spend limit on the Anthropic workspace too.

## Compare-at rules (worker/src/pricing.js)

Follows the FTC Guides Against Deceptive Pricing (16 CFR 233.2), which the Tennessee Consumer Protection
Act is read alongside. "Compare at" only for the identical item (brand known) at 2+ stores; otherwise
"Comparable value ... based on similar X at other retailers" from 3+ stores. One current price per store,
links must come from real search results, outliers dropped, lower median, rounded down, and no suggestion
when the store's price is already within about 10% of it. The number goes in the description, never in
Square's price or sale-price fields (Square shows those as the store's own former price).

## Running and deploying

```bash
cd worker && npm install
npm test                                   # pricing rules
node test/mock-anthropic.mjs &             # fake AI on :8788; .dev.vars points the Worker at it
npx wrangler dev --port 8787               # then open index.html?api=http://localhost:8787
npx wrangler deploy                        # publish the Worker
npx wrangler secret put ANTHROPIC_API_KEY  # set or rotate the AI key
npx wrangler tail                          # live logs, including tokens used per call
```

Square (optional): create a Square application, add `https://farmers-listing-helper.sitetime.workers.dev/api/square/callback`
as its OAuth redirect URL, then set `SQUARE_APP_ID`, `SQUARE_APP_SECRET` and a `STORE_PIN` of 6+ characters with
`wrangler secret put`. The store owner taps "Connect my Square store" once. Items arrive in the Square item
library; check visibility and photos there before they go live on the website.
