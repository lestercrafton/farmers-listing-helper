// A stand-in for the Anthropic API, for local end-to-end runs without a real key.
//   node test/mock-anthropic.mjs            (listens on :8788)
// Point the Worker at it with ANTHROPIC_BASE_URL=http://localhost:8788 in .dev.vars.
import http from "node:http";

const listing = {
  title: "BLU/WHT PORCELAIN GINGER JAR W/LID 12\"",
  description: "Cobalt blue florals wrap this glossy white porcelain ginger jar from shoulder to base, topped with a matching domed lid. Set it on a mantel or entry table, or pair two on a bookshelf for a classic chinoiserie look. It also makes a welcome housewarming gift.",
  social_post: "New on the shelf: a blue and white ginger jar that looks good everywhere. 💙 Shop in store on the square in Somerville or online!",
  category: "Home Decor",
  brand: "",
  search_phrase: "blue and white porcelain ginger jar with lid 12 inch",
  check_before_posting: "Confirm the height.",
};

const comps = {
  identified_as: "blue and white porcelain ginger jar",
  exact_product_found: false,
  comparables: [
    { retailer: "Ballard Designs", item: "Blue & White Ginger Jar, Medium", price: 79, price_type: "regular", match: "similar", market: "Atlanta", url: "https://www.ballarddesigns.com/blue-white-ginger-jar/123" },
    { retailer: "Pottery Barn", item: "Chinoiserie Ginger Jar", price: 69.5, price_type: "regular", match: "similar", market: "National", url: "https://www.potterybarn.com/products/chinoiserie-ginger-jar/" },
    { retailer: "Dillard's", item: "Southern Living Ginger Jar", price: 60, price_type: "regular", match: "similar", market: "National", url: "https://www.dillards.com/p/ginger-jar/999" },
    { retailer: "Made Up Shop", item: "Ginger jar", price: 500, price_type: "regular", match: "similar", market: "Memphis", url: "https://not-in-search-results.example/jar" },
    { retailer: "eBay", item: "Vintage ginger jar", price: 20, price_type: "regular", match: "similar", market: "National", url: "https://www.ebay.com/itm/1" },
  ],
  research_note: "No exact match turned up, but several similar lidded ginger jars of about this size are sold by home retailers.",
};

function message(content, extra = {}) {
  return {
    id: "msg_mock", type: "message", role: "assistant", model: "claude-opus-5", content,
    stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1500, output_tokens: 300 }, ...extra,
  };
}

http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.method !== "POST" || !req.url.startsWith("/v1/messages")) return send(404, { type: "error", error: { type: "not_found_error", message: "nope" } });
    let p;
    try { p = JSON.parse(body); } catch { return send(400, { type: "error", error: { type: "invalid_request_error", message: "bad json" } }); }
    const images = p.messages?.[0]?.content?.filter?.((b) => b.type === "image").length || 0;
    const isCompare = Array.isArray(p.tools) && p.tools.some((t) => t.name === "web_search");
    console.log(JSON.stringify({
      url: req.url, beta: req.headers["anthropic-beta"] || "", model: p.model, images, tools: (p.tools || []).map((t) => t.type),
      fallbacks: p.fallbacks, effort: p.output_config?.effort, format: p.output_config?.format?.type, thinking: p.thinking?.type, bytes: body.length,
    }));
    if (req.headers["x-api-key"] === "bad") return send(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
    const delay = Number(process.env.MOCK_DELAY_MS || (isCompare ? 2500 : 800));
    setTimeout(() => {
      if (!isCompare) return send(200, message([{ type: "text", text: JSON.stringify(listing) }]));
      send(200, message([
        { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "blue and white ginger jar 12 inch" } },
        { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [
          { type: "web_search_result", url: "https://www.ballarddesigns.com/blue-white-ginger-jar/123", title: "Blue & White Ginger Jar", encrypted_content: "x", page_age: null },
          { type: "web_search_result", url: "https://www.potterybarn.com/products/chinoiserie-ginger-jar/", title: "Chinoiserie Ginger Jar", encrypted_content: "x", page_age: null },
          { type: "web_search_result", url: "https://www.dillards.com/p/ginger-jar/999", title: "Ginger Jar", encrypted_content: "x", page_age: null },
          { type: "web_search_result", url: "https://www.ebay.com/itm/1", title: "Vintage jar", encrypted_content: "x", page_age: null },
        ] },
        { type: "text", text: JSON.stringify(comps) },
      ]));
    }, delay);
  });
}).listen(8788, () => console.log("mock anthropic on :8788"));
