const ext = globalThis.browser ?? globalThis.chrome;

function cleanText(v) {
  if (!v) return null;
  return String(v).replace(/\s+/g, " ").trim() || null;
}

function getRetailer() {
  const host = location.hostname;
  if (host.includes("woolworths")) return "woolworths";
  if (host.includes("coles")) return "coles";
  if (host.includes("aldi")) return "aldi";
  return null;
}

function getProductId(retailer, url) {
  if (retailer === "woolworths") {
    const m = url.match(/productdetails\/(\d+)/i);
    return m ? m[1] : null;
  }
  if (retailer === "coles") {
    const m = url.match(/\/product\/([^/?#]+)/i);
    return m ? m[1] : null;
  }
  if (retailer === "aldi") {
    const m = url.match(/\/products(?:\/[^/]+)*\/([^/?#]+)/i);
    return m ? m[1] : null;
  }
  return null;
}

function firstText(selectors) {
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) {
      const txt = cleanText(el.textContent);
      if (txt) return txt;
    }
  }
  return null;
}

function parseJsonLdProduct() {
  const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
  for (const script of scripts) {
    const raw = script.textContent;
    if (!raw) continue;
    try {
      const data = JSON.parse(raw);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const type = item["@type"];
        if (type === "Product" || (Array.isArray(type) && type.includes("Product"))) {
          return item;
        }
      }
    } catch (e) {}
  }
  return null;
}

function parseNutritionTable() {
  const tables = Array.from(document.querySelectorAll("table"));
  for (const table of tables) {
    const txt = (table.innerText || "").toLowerCase();
    if (!["energy", "protein", "fat", "carbohydrate", "sodium"].some(word => txt.includes(word))) {
      continue;
    }

    const rows = [];
    for (const tr of table.querySelectorAll("tr")) {
      const cells = Array.from(tr.querySelectorAll("th,td"))
        .map(x => cleanText(x.textContent))
        .filter(Boolean);
      if (cells.length) rows.push(cells);
    }

    if (rows.length) return rows;
  }
  return null;
}

function parsePriceFromPageText() {
  const txt = document.body.innerText || "";
  const m = txt.match(/\$\s*(\d+(?:\.\d{1,2})?)/);
  return m ? Number(m[1]) : null;
}

function extractPayload() {
  const retailer = getRetailer();
  const url = location.href;
  const productId = getProductId(retailer, url);
  const jsonLd = parseJsonLdProduct();

  let brand = null;
  let product = null;
  let size = null;
  let price = null;

  if (jsonLd && typeof jsonLd === "object") {
    brand = jsonLd.brand;
    if (brand && typeof brand === "object") {
      brand = brand.name || null;
    }
    product = jsonLd.name || null;
    size = jsonLd.size || jsonLd.weight || null;

    if (jsonLd.offers && typeof jsonLd.offers === "object" && jsonLd.offers.price) {
      const parsed = Number(jsonLd.offers.price);
      if (!Number.isNaN(parsed)) price = parsed;
    }
  }

  if (retailer === "woolworths") {
    brand = brand || firstText(['[data-testid="brand"]', '[class*="brand"]']);
    product = product || firstText(["h1"]);
    size = size || firstText(['[data-testid="package-size"]', '[class*="size"]']);
  } else if (retailer === "coles") {
    brand = brand || firstText(['[data-testid="product-brand"]', '[class*="brand"]']);
    product = product || firstText(["h1"]);
    size = size || firstText(['[data-testid="product-size"]', '[class*="size"]']);
  } else if (retailer === "aldi") {
    brand = brand || firstText(['[class*="brand"]']);
    product = product || firstText(["h1"]);
    size = size || firstText(['[class*="size"]']);
  }

  price = price ?? parsePriceFromPageText();

  return {
    retailer,
    product_id: productId,
    url,
    title: document.title,
    parsed: {
      brand: cleanText(brand),
      product: cleanText(product),
      size: cleanText(size),
      price,
      nutrition: parseNutritionTable()
    },
    raw_html: document.documentElement.outerHTML,
    captured_at: new Date().toISOString(),
    extension_version: ext.runtime.getManifest().version
  };
}

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "EXTRACT_PAGE") {
    try {
      const payload = extractPayload();
      sendResponse({ ok: true, data: payload });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
    return true;
  }
});
