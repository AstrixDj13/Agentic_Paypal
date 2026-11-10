// PayPal Pocket shopping memory: runs on web pages, but only ever reports two things:
//   1. product pages (pages that publish schema.org Product data, or og:type=product)
//   2. searches on shopping and search sites
// Everything else is ignored. Nothing is sent unless the browser is paired with Pocket.
(() => {
  const SENSITIVE = /(bank|banking|credit|loan|mortgage|insur|health|clinic|hospital|pharma|medical|doctor|dating|\.gov|tax|payroll|webmail|login|signin|account|password|checkout|cart\/payment)/i;
  if (!/^https?:$/.test(location.protocol) || SENSITIVE.test(location.hostname + location.pathname)) return;

  const send = (signal) => { try { chrome.runtime.sendMessage({ type: "signal", signal }); } catch { /* extension reloaded */ } };
  const text = (v) => (typeof v === "string" ? v.trim() : "");

  /* ---------------- Searches on shopping / search sites ---------------- */
  const SEARCH = [
    [/(^|\.)google\.[a-z.]+$/, "q", /^\/search/],
    [/(^|\.)bing\.com$/, "q", /^\/(search|shop)/],
    [/(^|\.)duckduckgo\.com$/, "q", /^\//],
    [/(^|\.)amazon\.[a-z.]+$/, "k", /^\/s/],
    [/(^|\.)ebay\.[a-z.]+$/, "_nkw", /^\/sch/],
    [/(^|\.)walmart\.com$/, "q", /^\/search/],
    [/(^|\.)target\.com$/, "searchTerm", /^\/s/],
    [/(^|\.)nike\.com$/, "q", /^\/([a-z]{2}\/)?w/],
    [/(^|\.)adidas\.[a-z.]+$/, "q", /^\/search/],
    [/(^|\.)stockx\.com$/, "s", /^\/search/],
    [/(^|\.)etsy\.com$/, "q", /^\/search/],
    [/(^|\.)bestbuy\.com$/, "st", /^\/site\/searchpage/],
    [/(^|\.)zalando\.[a-z.]+$/, "q", /^\//],
    [/(^|\.)asos\.com$/, "q", /^\/search/],
  ];
  for (const [host, param, path] of SEARCH) {
    if (host.test(location.hostname) && path.test(location.pathname)) {
      const q = new URLSearchParams(location.search).get(param);
      if (q && q.trim().length > 1) send({ kind: "search", query: q.trim().slice(0, 160), url: location.href, domain: location.hostname });
      break;
    }
  }

  /* ---------------- Product pages ---------------- */
  function findProduct(node) {
    if (!node || typeof node !== "object") return null;
    if (Array.isArray(node)) { for (const n of node) { const p = findProduct(n); if (p) return p; } return null; }
    const t = node["@type"];
    if (t === "Product" || (Array.isArray(t) && t.includes("Product")) || t === "ProductGroup") return node;
    return findProduct(node["@graph"]) || findProduct(node.mainEntity) || null;
  }
  function fromJsonLd() {
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const p = findProduct(JSON.parse(s.textContent || ""));
        if (!p) continue;
        const offers = Array.isArray(p.offers) ? p.offers[0] : p.offers || (p.hasVariant && p.hasVariant[0] && p.hasVariant[0].offers) || {};
        const img = Array.isArray(p.image) ? p.image[0] : p.image;
        return {
          title: text(p.name),
          brand: text(typeof p.brand === "object" && p.brand ? p.brand.name : p.brand),
          price: Number(offers.price ?? offers.lowPrice) || undefined,
          currency: text(offers.priceCurrency),
          imageUrl: text(typeof img === "object" && img ? img.url : img),
          size: text(p.size),
        };
      } catch { /* malformed JSON-LD: ignore */ }
    }
    return null;
  }
  function fromMeta() {
    const m = (n) => document.querySelector(`meta[property="${n}"], meta[name="${n}"]`)?.getAttribute("content") || "";
    if (!/product/i.test(m("og:type"))) return null;
    return { title: m("og:title"), brand: m("product:brand") || m("og:brand"), price: Number(m("product:price:amount") || m("og:price:amount")) || undefined, currency: m("product:price:currency"), imageUrl: m("og:image") };
  }

  const product = fromJsonLd() || fromMeta();
  if (!product || !product.title) return;
  const base = { kind: "view", ...product, url: location.href.split("#")[0], domain: location.hostname };

  // Dwell: count only time the tab is actually visible. Report once after 5 s, then the rest when leaving.
  let visibleSince = document.visibilityState === "visible" ? Date.now() : 0;
  let reported = 0;
  let total = 0;
  const tick = () => { if (visibleSince) { total += Date.now() - visibleSince; visibleSince = Date.now(); } };
  const flush = () => {
    tick();
    const delta = total - reported;
    if (delta < 1500) return;
    send({ ...base, dwellMs: delta });
    reported = total;
  };
  setTimeout(flush, 5000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") visibleSince = Date.now();
    else { flush(); visibleSince = 0; }
  });
  addEventListener("pagehide", flush);
})();
