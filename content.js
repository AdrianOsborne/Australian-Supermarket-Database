function text(el) {
    const raw = table.innerText.toLowerCase();
    if (!raw.includes("energy") && !raw.includes("protein") && !raw.includes("fat")) continue;

    const rows = Array.from(table.querySelectorAll("tr"));
    const out = {};
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("th, td")).map(x => x.textContent.trim()).filter(Boolean);
      if (cells.length >= 2) {
        const key = cells[0];
        out[key] = cells.slice(1);
      }
    }
    if (Object.keys(out).length) return out;
  }
  return null;
}

function parsePriceFromText() {
  const bodyText = document.body.innerText;
  const m = bodyText.match(/\$\s*(\d+(?:\.\d{1,2})?)/);
  return m ? parseFloat(m[1]) : null;
}

function extract() {
  const retailer = getRetailer();
  const jsonLd = parseJsonLd();

  const product =
    jsonLd?.name ||
    metaContent('meta[property="og:title"]') ||
    text(document.querySelector("h1"));

  const brand =
    jsonLd?.brand?.name ||
    jsonLd?.brand ||
    text(document.querySelector('[data-testid="brand"]')) ||
    null;

  const size =
    text(document.querySelector('[data-testid="package-size"]')) ||
    text(document.querySelector('[class*="size"]')) ||
    null;

  const price =
    (jsonLd?.offers && Number(jsonLd.offers.price)) ||
    parsePriceFromText();

  const nutrition = parseNutritionTable();

  return {
    retailer,
    url: location.href,
    title: document.title,
    product_id: getProductId(retailer, location.href),
    parsed: {
      brand,
      product,
      size,
      price: Number.isFinite(price) ? price : null,
      nutrition
    },
    raw_html: document.documentElement.outerHTML,
    captured_at: new Date().toISOString(),
    extension_version: chrome.runtime.getManifest().version
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "EXTRACT_PAGE") {
    try {
      sendResponse({ ok: true, data: extract() });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
    return true;
  }
});