const ext = globalThis.browser ?? globalThis.chrome;

const OVERLAY_ID = "au-supermarket-db-overlay-root";
const STYLE_ID = "au-supermarket-db-overlay-style";
const MIN_KEY = "au_supermarket_overlay_minimized";

let overlayRoot = null;
let lastHandledUrl = "";
let lastAutoAttemptSignature = "";
let lastSeenExtractedSignature = "";
let bootTimer = null;
let mutationObserver = null;

function cleanText(v) {
  if (!v) return null;
  return String(v).replace(/\s+/g, " ").trim() || null;
}

function htmlEscape(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getRetailer() {
  const host = location.hostname.toLowerCase();

  if (host === "www.woolworths.com.au" || host === "woolworths.com.au") return "woolworths";
  if (host === "www.coles.com.au" || host === "coles.com.au") return "coles";
  if (host === "www.aldi.com.au" || host === "aldi.com.au") return "aldi";

  return null;
}

function isGitHubDevicePage() {
  try {
    const url = new URL(location.href);
    return url.hostname === "github.com" && url.pathname === "/login/device";
  } catch {
    return false;
  }
}

function getProductId(retailer, urlString) {
  try {
    const url = new URL(urlString);
    const path = url.pathname;

    if (retailer === "woolworths") {
      const m = path.match(/\/shop\/productdetails\/(\d+)/i);
      return m ? m[1] : null;
    }

    if (retailer === "coles") {
      const numericTail = path.match(/\/product\/.*-(\d+)(?:\/)?$/i);
      if (numericTail) return numericTail[1];

      const slug = path.match(/\/product\/([^/?#]+)/i);
      if (slug) return slug[1].toLowerCase();

      return null;
    }

    if (retailer === "aldi") {
      const longNumeric = path.match(/-(\d{6,})\/?$/i);
      if (longNumeric) return longNumeric[1];

      const slug = path.match(/\/product\/([^/?#]+)/i);
      if (slug) return slug[1].toLowerCase();

      return null;
    }

    return null;
  } catch {
    return null;
  }
}

function isSupportedProductPage() {
  const retailer = getRetailer();
  if (!retailer) return false;

  const pathname = new URL(location.href).pathname;

  if (retailer === "woolworths") {
    return /\/shop\/productdetails\/\d+/i.test(pathname);
  }

  if (retailer === "coles") {
    return /\/product\/.+/i.test(pathname);
  }

  if (retailer === "aldi") {
    return /\/product\/.+/i.test(pathname);
  }

  return false;
}

function shouldShowOverlay() {
  return isSupportedProductPage() || isGitHubDevicePage();
}

function firstText(selectors) {
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (!el) continue;
    const txt = cleanText(el.textContent);
    if (txt) return txt;
  }
  return null;
}

function firstAttr(selectors, attr = "src") {
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (!el) continue;
    const val = cleanText(el.getAttribute(attr));
    if (val) return val;
  }
  return null;
}

function absoluteUrlMaybe(v) {
  if (!v) return null;
  try {
    return new URL(v, location.href).href;
  } catch {
    return v;
  }
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
    } catch {}
  }

  return null;
}

function parsePriceFromPageText() {
  const txt = document.body.innerText || "";
  const m = txt.match(/\$\s*(\d+(?:\.\d{1,2})?)/);
  return m ? Number(m[1]) : null;
}

function parsePriceValue(text) {
  const value = cleanText(text);
  if (!value) return null;

  const labelMatch = value.match(/price\s+\$?\s*(\d+(?:\.\d{1,2})?)/i);
  if (labelMatch) return Number(labelMatch[1]);

  const currencyMatch = value.match(/\$\s*(\d+(?:\.\d{1,2})?)/);
  if (currencyMatch) return Number(currencyMatch[1]);

  const plainMatch = value.match(/\b(\d+(?:\.\d{1,2})?)\b/);
  return plainMatch ? Number(plainMatch[1]) : null;
}

function parsePriceFromSelectors(selectors, attr) {
  for (const selector of selectors) {
    const nodes = document.querySelectorAll(selector);
    for (const node of nodes) {
      const raw = attr ? node.getAttribute(attr) : node.textContent;
      const parsed = parsePriceValue(raw);
      if (parsed !== null && !Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function splitNameAndMeasurement(text) {
  const value = cleanText(text);
  if (!value) {
    return {
      productName: null,
      measurement: null
    };
  }

  const m = value.match(/(.+?)\s+(\d+(?:\.\d+)?\s?(?:kg|g|mg|l|ml|each|pack))$/i);
  if (!m) {
    return {
      productName: value,
      measurement: null
    };
  }

  return {
    productName: cleanText(m[1]),
    measurement: cleanText(m[2])
  };
}

function parsePackAmount(productName) {
  const value = cleanText(productName);
  if (!value) return null;

  const m =
    value.match(/(\d+)\s*pack\b/i) ||
    value.match(/\bpack of\s*(\d+)\b/i) ||
    value.match(/\b(\d+)\s*x\b/i) ||
    value.match(/\b(\d+)\s*pk\b/i);

  return m ? m[1] : null;
}

function normalizeBrandAndName(retailer, brandText, fullNameText) {
  let brand = cleanText(brandText);
  let fullName = cleanText(fullNameText);

  if (!brand && !fullName) {
    return {
      brand: null,
      productName: null
    };
  }

  if (retailer === "aldi") {
    return {
      brand: brand || null,
      productName: fullName || null
    };
  }

  if (retailer === "coles") {
    if (!brand && fullName) {
      const parts = fullName.split(/\s+/);
      brand = parts.slice(0, 2).join(" ");
    }

    if (brand && fullName) {
      const escaped = brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      fullName = cleanText(fullName.replace(new RegExp(`^${escaped}\\s+`, "i"), ""));
    }

    return {
      brand: brand || null,
      productName: fullName || null
    };
  }

  if (retailer === "woolworths") {
    if (!brand && fullName) {
      const parts = fullName.split(/\s+/);
      brand = parts[0] || null;
    }

    if (brand && fullName) {
      const escaped = brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const trimmed = cleanText(fullName.replace(new RegExp(`^${escaped}\\s+`, "i"), ""));
      return {
        brand,
        productName: trimmed || fullName
      };
    }

    return {
      brand: brand || null,
      productName: fullName || null
    };
  }

  return {
    brand: brand || null,
    productName: fullName || null
  };
}

function buildCompactRawHtml(data) {
  return `
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${htmlEscape(data.title || "")}</title>
</head>
<body>
  <div data-retailer="${htmlEscape(data.retailer || "")}">
    <div data-product-id="${htmlEscape(data.product_id || "")}"></div>
    <div data-url="${htmlEscape(data.url || "")}"></div>
    <div data-brand="${htmlEscape(data.parsed?.brand || "")}"></div>
    <div data-product="${htmlEscape(data.parsed?.product || "")}"></div>
    <div data-size="${htmlEscape(data.parsed?.size || "")}"></div>
    <div data-pack-amount="${htmlEscape(data.parsed?.pack_amount || "")}"></div>
    <div data-measurement="${htmlEscape(data.parsed?.measurement || "")}"></div>
    <div data-price="${htmlEscape(data.parsed?.price ?? "")}"></div>
    <img src="${htmlEscape(data.parsed?.image_url || "")}" alt="${htmlEscape(data.parsed?.product || "")}">
  </div>
</body>
</html>
  `.trim();
}

function extractPayload() {
  const retailer = getRetailer();
  const url = location.href;
  const productId = getProductId(retailer, url);
  const jsonLd = parseJsonLdProduct();

  if (!retailer) {
    throw new Error("Unsupported retailer.");
  }

  if (!productId) {
    throw new Error("Could not determine product_id from this page URL.");
  }

  let brandText = null;
  let fullNameText = null;
  let measurement = null;
  let price = null;
  let imageUrl = null;

  if (jsonLd && typeof jsonLd === "object") {
    brandText = typeof jsonLd.brand === "object" ? jsonLd.brand?.name : jsonLd.brand || null;
    fullNameText = jsonLd.name || null;
    measurement = jsonLd.size || jsonLd.weight || null;

    if (jsonLd.offers && typeof jsonLd.offers === "object" && jsonLd.offers.price) {
      const parsed = Number(jsonLd.offers.price);
      if (!Number.isNaN(parsed)) {
        price = parsed;
      }
    }

    if (typeof jsonLd.image === "string") {
      imageUrl = jsonLd.image;
    } else if (Array.isArray(jsonLd.image) && jsonLd.image.length) {
      imageUrl = jsonLd.image[0];
    }
  }

  if (retailer === "aldi") {
    brandText = brandText || firstText([
      'a[href*="/brand/"]',
      '[class*="brand"]',
      '[class*="Brand"]'
    ]);

    fullNameText = fullNameText || firstText([
      "h1",
      '[class*="product-title"]',
      '[class*="ProductTitle"]'
    ]);

    imageUrl = imageUrl || firstAttr([
      'img[alt][src*="product"]',
      "main img[src]",
      ".swiper img[src]"
    ], "src");
  }

  if (retailer === "coles") {
    brandText = brandText || firstText([
      'a[href*="/brand/"]',
      '[data-testid="product-brand"]',
      '[class*="brand"]'
    ]);

    fullNameText = fullNameText || firstText([
      "h1"
    ]);

    imageUrl = imageUrl || firstAttr([
      'img[src*="productimages"]',
      "main img[src]",
      '[class*="image"] img[src]'
    ], "src");

    price = price ?? parsePriceFromSelectors([
      '[data-testid="pricing"] [aria-label^="Price "]',
      '[data-testid="product-buy"] [aria-label^="Price "]',
      '[data-testid="pricing"] .price .price_value',
      '[data-testid="product-buy"] .price .price_value',
      '[data-testid="pricing"] [class*="price_value"]',
      '[data-testid="product-buy"] [class*="price_value"]'
    ], null);
  }

  if (retailer === "woolworths") {
    fullNameText = fullNameText || firstText([
      "h1",
      '[data-testid="product-title"]'
    ]);

    imageUrl = imageUrl || firstAttr([
      'img[src*="cdn0.woolworths.media"]',
      "main img[src]",
      '[data-testid="product-image"] img[src]'
    ], "src");
  }

  const normalized = normalizeBrandAndName(retailer, brandText, fullNameText);
  const split = splitNameAndMeasurement(normalized.productName || fullNameText || "");

  let finalMeasurement = cleanText(measurement) || split.measurement;
  let finalProductName = split.productName || normalized.productName || cleanText(fullNameText);
  let packAmount = parsePackAmount(finalProductName);
  price = price ?? parsePriceFromPageText();
  imageUrl = absoluteUrlMaybe(imageUrl);

  if (!finalProductName) {
    throw new Error("Could not determine product name.");
  }

  const payload = {
    retailer,
    product_id: String(productId),
    url,
    title: document.title,
    parsed: {
      brand: cleanText(normalized.brand),
      product: cleanText(finalProductName),
      size: cleanText(finalMeasurement),
      pack_amount: cleanText(packAmount),
      measurement: cleanText(finalMeasurement),
      price,
      image_url: imageUrl
    },
    captured_at: new Date().toISOString(),
    extension_version: ext.runtime.getManifest().version
  };

  payload.raw_html = buildCompactRawHtml(payload);

  if (!payload.raw_html || payload.raw_html.length < 100) {
    throw new Error("Compact snapshot was too small.");
  }

  return payload;
}

async function sendRuntimeMessage(message) {
  return await ext.runtime.sendMessage(message);
}

async function getState() {
  const res = await sendRuntimeMessage({ type: "GET_STATE" });
  if (!res?.ok) throw new Error(res?.error || "Failed to get state.");
  return res.data;
}

async function startLogin() {
  const res = await sendRuntimeMessage({ type: "START_GITHUB_LOGIN" });
  if (!res?.ok) throw new Error(res?.error || "Login failed.");
  return res.data;
}

async function setTheme(theme) {
  const res = await sendRuntimeMessage({ type: "SET_THEME", theme });
  if (!res?.ok) throw new Error(res?.error || "Failed to set theme.");
  return res.data;
}

async function setAutoSubmit(value) {
  const res = await sendRuntimeMessage({ type: "SET_AUTO_SUBMIT", value });
  if (!res?.ok) throw new Error(res?.error || "Failed to set auto submit.");
  return res.data;
}

async function submitPayload(payload) {
  const res = await sendRuntimeMessage({ type: "SUBMIT_PAYLOAD", payload });
  if (!res?.ok) throw new Error(res?.error || "Submit failed.");
  return res.data;
}

async function tryAutoSubmit(payload) {
  const res = await sendRuntimeMessage({
    type: "PAGE_READY_FOR_AUTO_SUBMIT",
    payload
  });

  if (!res?.ok) throw new Error(res?.error || "Auto submit failed.");
  return res.data;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function isMinimized() {
  return localStorage.getItem(MIN_KEY) === "1";
}

function setMinimized(value) {
  localStorage.setItem(MIN_KEY, value ? "1" : "0");
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 2147483647;
      font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    }

    #${OVERLAY_ID} .au-card {
      width: 340px;
      max-width: calc(100vw - 32px);
      border-radius: 18px;
      box-shadow: 0 12px 36px rgba(0,0,0,0.28);
      padding: 14px;
      border: 1px solid rgba(255,255,255,0.08);
      backdrop-filter: blur(14px);
    }

    #${OVERLAY_ID}[data-theme="dark"] .au-card {
      background: rgba(18, 20, 24, 0.96);
      color: #f4f7fb;
    }

    #${OVERLAY_ID}[data-theme="light"] .au-card {
      background: rgba(255,255,255,0.96);
      color: #16202b;
      border-color: rgba(0,0,0,0.08);
    }

    #${OVERLAY_ID} .au-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 10px;
    }

    #${OVERLAY_ID} .au-top-actions {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    #${OVERLAY_ID} .au-title {
      font-size: 14px;
      font-weight: 700;
      line-height: 1.3;
      margin: 0;
    }

    #${OVERLAY_ID} .au-subtitle {
      font-size: 12px;
      opacity: 0.72;
      margin: 4px 0 0;
    }

    #${OVERLAY_ID} .au-theme-btn,
    #${OVERLAY_ID} .au-min-btn,
    #${OVERLAY_ID} .au-primary-btn,
    #${OVERLAY_ID} .au-secondary-btn {
      border: 0;
      border-radius: 12px;
      cursor: pointer;
      transition: transform 0.12s ease, opacity 0.12s ease;
    }

    #${OVERLAY_ID} .au-theme-btn:hover,
    #${OVERLAY_ID} .au-min-btn:hover,
    #${OVERLAY_ID} .au-primary-btn:hover,
    #${OVERLAY_ID} .au-secondary-btn:hover {
      transform: translateY(-1px);
    }

    #${OVERLAY_ID} .au-theme-btn,
    #${OVERLAY_ID} .au-min-btn {
      width: 38px;
      height: 38px;
      font-size: 16px;
      background: rgba(127,127,127,0.16);
      color: inherit;
      flex-shrink: 0;
    }

    #${OVERLAY_ID} .au-primary-btn {
      width: 100%;
      padding: 11px 12px;
      font-weight: 700;
      background: linear-gradient(135deg, #2b7cff, #6a5cff);
      color: white;
      margin-top: 10px;
    }

    #${OVERLAY_ID} .au-secondary-btn {
      width: 100%;
      padding: 10px 12px;
      font-weight: 600;
      background: rgba(127,127,127,0.14);
      color: inherit;
      margin-top: 8px;
    }

    #${OVERLAY_ID} .au-meta {
      display: grid;
      grid-template-columns: 1fr;
      gap: 8px;
      margin-top: 10px;
      font-size: 12px;
    }

    #${OVERLAY_ID} .au-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 700;
      border-radius: 999px;
      padding: 6px 10px;
      background: rgba(127,127,127,0.14);
    }

    #${OVERLAY_ID} .au-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    #${OVERLAY_ID} .au-label {
      font-size: 12px;
      font-weight: 600;
    }

    #${OVERLAY_ID} .au-hint,
    #${OVERLAY_ID} .au-status,
    #${OVERLAY_ID} .au-small {
      font-size: 12px;
      line-height: 1.45;
      opacity: 0.82;
    }

    #${OVERLAY_ID} .au-status {
      margin-top: 10px;
      height: 140px;
      white-space: pre-wrap;
      word-break: break-word;
      overflow: auto;
      padding: 10px;
      border-radius: 12px;
      background: rgba(127,127,127,0.08);
    }

    #${OVERLAY_ID} .au-device-box {
      margin-top: 12px;
      padding: 12px;
      border-radius: 14px;
      background: rgba(127,127,127,0.08);
      border: 1px solid rgba(127,127,127,0.16);
    }

    #${OVERLAY_ID} .au-device-code {
      margin-top: 8px;
      padding: 12px;
      border-radius: 12px;
      text-align: center;
      font-size: 22px;
      font-weight: 800;
      letter-spacing: 0.18em;
      background: rgba(127,127,127,0.12);
      user-select: all;
    }

    #${OVERLAY_ID} .au-button-row {
      display: flex;
      gap: 8px;
      margin-top: 10px;
    }

    #${OVERLAY_ID} .au-button-row .au-secondary-btn {
      width: 100%;
      margin-top: 0;
    }

    #${OVERLAY_ID} .au-switch {
      position: relative;
      display: inline-block;
      width: 48px;
      height: 28px;
      flex-shrink: 0;
    }

    #${OVERLAY_ID} .au-switch input {
      opacity: 0;
      width: 0;
      height: 0;
    }

    #${OVERLAY_ID} .au-slider {
      position: absolute;
      inset: 0;
      border-radius: 999px;
      background: rgba(127,127,127,0.28);
      transition: 0.2s ease;
    }

    #${OVERLAY_ID} .au-slider::before {
      content: "";
      position: absolute;
      width: 22px;
      height: 22px;
      left: 3px;
      top: 3px;
      border-radius: 50%;
      background: white;
      transition: 0.2s ease;
      box-shadow: 0 1px 3px rgba(0,0,0,0.2);
    }

    #${OVERLAY_ID} input:checked + .au-slider {
      background: linear-gradient(135deg, #2b7cff, #6a5cff);
    }

    #${OVERLAY_ID} input:checked + .au-slider::before {
      transform: translateX(20px);
    }

    #${OVERLAY_ID} .au-hidden {
      display: none !important;
    }

    #${OVERLAY_ID}.au-collapsed .au-card {
      width: auto;
      padding: 0;
      border: 0;
      background: transparent !important;
      box-shadow: none;
      backdrop-filter: none;
    }

    #${OVERLAY_ID}.au-collapsed .au-top {
      margin: 0;
    }

    #${OVERLAY_ID}.au-collapsed .au-title-wrap,
    #${OVERLAY_ID}.au-collapsed .au-body,
    #${OVERLAY_ID}.au-collapsed #auThemeBtn {
      display: none !important;
    }

    #${OVERLAY_ID}.au-collapsed .au-top-actions {
      gap: 0;
    }

    #${OVERLAY_ID}.au-collapsed #auMinBtn {
      width: 48px;
      height: 48px;
      border-radius: 999px;
      box-shadow: 0 12px 36px rgba(0,0,0,0.28);
      background: linear-gradient(135deg, #2b7cff, #6a5cff);
      color: white;
      font-size: 24px;
    }
  `;
  document.documentElement.appendChild(style);
}

function ensureOverlay() {
  ensureStyle();

  let root = document.getElementById(OVERLAY_ID);
  if (!root) {
    root = document.createElement("div");
    root.id = OVERLAY_ID;
    root.innerHTML = `
      <div class="au-card">
        <div class="au-top">
          <div class="au-title-wrap">
            <div class="au-title">Australian Supermarket Database</div>
            <div class="au-subtitle">Automatic page extractor</div>
          </div>
          <div class="au-top-actions">
            <button id="auMinBtn" class="au-min-btn" type="button" title="Minimise">−</button>
            <button id="auThemeBtn" class="au-theme-btn" type="button" title="Toggle theme">☀</button>
          </div>
        </div>

        <div class="au-body">
          <div id="auLoggedOutView">
            <div class="au-hint">Sign in with GitHub to submit product pages automatically.</div>
            <button id="auLoginBtn" class="au-primary-btn" type="button">Sign in with GitHub</button>

            <div id="auDeviceFlowBox" class="au-device-box au-hidden">
              <div class="au-label">GitHub activation code</div>
              <div id="auDeviceCode" class="au-device-code">......</div>
              <div class="au-button-row">
                <button id="auCopyCodeBtn" class="au-secondary-btn" type="button">Copy code</button>
                <button id="auOpenGithubBtn" class="au-secondary-btn" type="button">Open GitHub</button>
              </div>
              <div id="auDeviceFlowUrl" class="au-status"></div>
            </div>

            <div id="auAuthHint" class="au-status au-hidden"></div>
          </div>

          <div id="auLoggedInView" class="au-hidden">
            <div class="au-row">
              <div>
                <div class="au-label">Signed in as</div>
                <div id="auUserLogin" class="au-small"></div>
              </div>
              <div class="au-pill">Ready</div>
            </div>

            <div class="au-meta">
              <div class="au-row">
                <div>
                  <div class="au-label">Auto submit</div>
                  <div class="au-small">Enabled by default</div>
                </div>
                <label class="au-switch">
                  <input id="auAutoSubmitToggle" type="checkbox">
                  <span class="au-slider"></span>
                </label>
              </div>
            </div>

            <div id="auManualActions">
              <button id="auExtractBtn" class="au-secondary-btn" type="button">Extract current page</button>
              <button id="auSubmitBtn" class="au-primary-btn" type="button">Submit current page</button>
            </div>

            <div id="auStatus" class="au-status">Waiting.</div>
          </div>
        </div>
      </div>
    `;
    document.documentElement.appendChild(root);
  }

  overlayRoot = root;
  return root;
}

function setOverlayTheme(theme) {
  ensureOverlay();
  overlayRoot.setAttribute("data-theme", theme === "light" ? "light" : "dark");

  const btn = overlayRoot.querySelector("#auThemeBtn");
  if (btn) {
    btn.textContent = theme === "light" ? "☾" : "☀";
    btn.title = theme === "light" ? "Switch to dark mode" : "Switch to light mode";
  }
}

function applyMinimizedState() {
  ensureOverlay();
  const minimized = isGitHubDevicePage() ? false : isMinimized();
  overlayRoot.classList.toggle("au-collapsed", minimized);

  const btn = overlayRoot.querySelector("#auMinBtn");
  if (btn) {
    btn.textContent = minimized ? "+" : "−";
    btn.title = minimized ? "Expand" : "Minimise";
  }
}

function setStatus(text) {
  ensureOverlay();
  const el = overlayRoot.querySelector("#auStatus");
  if (el) el.textContent = text || "";
}

function setAuthHint(text, show = true) {
  ensureOverlay();
  const el = overlayRoot.querySelector("#auAuthHint");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("au-hidden", !show || !text);
}

function renderDeviceFlow(state) {
  ensureOverlay();

  const box = overlayRoot.querySelector("#auDeviceFlowBox");
  const codeEl = overlayRoot.querySelector("#auDeviceCode");
  const urlEl = overlayRoot.querySelector("#auDeviceFlowUrl");

  const show = state.authStatus === "waiting_for_authorization" && !!state.pendingUserCode;

  box.classList.toggle("au-hidden", !show);

  if (!show) {
    codeEl.textContent = "......";
    urlEl.textContent = "";
    return;
  }

  codeEl.textContent = state.pendingUserCode || "";
  urlEl.textContent = state.pendingVerificationUri
    ? `Open ${state.pendingVerificationUri} and paste the code above.`
    : "Open GitHub device activation and paste the code above.";
}

async function renderOverlay() {
  if (!shouldShowOverlay()) {
    if (overlayRoot) {
      overlayRoot.remove();
      overlayRoot = null;
    }
    return;
  }

  const state = await getState();
  ensureOverlay();
  setOverlayTheme(state.theme || "dark");
  applyMinimizedState();

  const loggedOutView = overlayRoot.querySelector("#auLoggedOutView");
  const loggedInView = overlayRoot.querySelector("#auLoggedInView");
  const loginBtn = overlayRoot.querySelector("#auLoginBtn");
  const themeBtn = overlayRoot.querySelector("#auThemeBtn");
  const minBtn = overlayRoot.querySelector("#auMinBtn");
  const userLogin = overlayRoot.querySelector("#auUserLogin");
  const autoToggle = overlayRoot.querySelector("#auAutoSubmitToggle");
  const extractBtn = overlayRoot.querySelector("#auExtractBtn");
  const submitBtn = overlayRoot.querySelector("#auSubmitBtn");
  const manualActions = overlayRoot.querySelector("#auManualActions");
  const copyCodeBtn = overlayRoot.querySelector("#auCopyCodeBtn");
  const openGithubBtn = overlayRoot.querySelector("#auOpenGithubBtn");
  const loginHintEl = overlayRoot.querySelector("#auLoggedOutView .au-hint");

  const signedIn = !!(state.githubAccessToken && state.githubUserLogin);

  loggedOutView.classList.toggle("au-hidden", signedIn);
  loggedInView.classList.toggle("au-hidden", !signedIn);

  if (loginHintEl) {
    if (isGitHubDevicePage()) {
      loginHintEl.textContent = "Use the code below on this GitHub page to finish signing in.";
    } else {
      loginHintEl.textContent = "Sign in with GitHub to submit product pages automatically.";
    }
  }

  renderDeviceFlow(state);

  if (signedIn) {
    userLogin.textContent = state.githubUserLogin || "";
    autoToggle.checked = state.autoSubmit !== false;
    manualActions.classList.toggle("au-hidden", state.autoSubmit !== false);
    setAuthHint("", false);
  } else {
    if (state.authStatus === "waiting_for_authorization") {
      setAuthHint("GitHub is waiting for you to enter the activation code.", true);
    } else {
      setAuthHint("", false);
    }
  }

  themeBtn.onclick = async () => {
    try {
      const nextTheme = (await getState()).theme === "light" ? "dark" : "light";
      await setTheme(nextTheme);
      await renderOverlay();
    } catch (e) {
      console.error(e);
    }
  };

  minBtn.onclick = async () => {
    setMinimized(!isMinimized());
    applyMinimizedState();
  };

  loginBtn.onclick = async () => {
    try {
      setAuthHint("Starting GitHub sign in...", true);

      startLogin().catch(async err => {
        setAuthHint(String(err && err.message ? err.message : err), true);
        await renderOverlay();
      });

      setTimeout(() => {
        renderOverlay().catch(console.error);
      }, 300);

      const poll = setInterval(async () => {
        try {
          const s = await getState();
          await renderOverlay();

          if (s.githubAccessToken && s.githubUserLogin) {
            clearInterval(poll);
            setStatus(`Signed in as ${s.githubUserLogin}`);
            return;
          }

          if (s.authStatus === "signed_out" && !s.pendingUserCode) {
            clearInterval(poll);
          }
        } catch {
          clearInterval(poll);
        }
      }, 1500);
    } catch (e) {
      setAuthHint(String(e && e.message ? e.message : e), true);
    }
  };

  copyCodeBtn.onclick = async () => {
    const s = await getState();
    const code = s.pendingUserCode || "";
    if (!code) return;
    const ok = await copyText(code);
    setAuthHint(ok ? "Code copied to clipboard." : "Could not copy code automatically.", true);
  };

  openGithubBtn.onclick = async () => {
    const s = await getState();
    const url = s.pendingVerificationUri || "https://github.com/login/device";
    window.open(url, "_blank");
  };

  autoToggle.onchange = async () => {
    try {
      await setAutoSubmit(autoToggle.checked);
      await renderOverlay();
      setStatus(autoToggle.checked ? "Auto submit enabled." : "Auto submit disabled.");
      scheduleBoot(50);
    } catch (e) {
      setStatus(String(e && e.message ? e.message : e));
    }
  };

  extractBtn.onclick = async () => {
    try {
      const payload = extractPayload();
      setStatus(JSON.stringify(payload, null, 2));
    } catch (e) {
      setStatus(String(e && e.message ? e.message : e));
    }
  };

  submitBtn.onclick = async () => {
    try {
      const payload = extractPayload();
      const issue = await submitPayload(payload);
      setStatus(`Submitted successfully.\n${issue.html_url}`);
    } catch (e) {
      setStatus(String(e && e.message ? e.message : e));
    }
  };
}

async function handleAutomaticFlow() {
  if (!isSupportedProductPage()) return;

  const payload = extractPayload();
  const signature = JSON.stringify({
    retailer: payload.retailer,
    product_id: payload.product_id,
    url: payload.url,
    brand: payload.parsed?.brand,
    product: payload.parsed?.product,
    size: payload.parsed?.size,
    pack_amount: payload.parsed?.pack_amount,
    measurement: payload.parsed?.measurement,
    price: payload.parsed?.price,
    image_url: payload.parsed?.image_url
  });

  if (signature === lastAutoAttemptSignature) return;
  lastAutoAttemptSignature = signature;

  const state = await getState();
  await renderOverlay();

  if (!state.githubAccessToken || !state.githubUserLogin) return;

  if (state.autoSubmit === false) {
    setStatus("Signed in. Auto submit is disabled.");
    return;
  }

  try {
    setStatus(
      `Submitting automatically...
Retailer: ${payload.retailer}
Product ID: ${payload.product_id}
Brand: ${payload.parsed?.brand || ""}
Product: ${payload.parsed?.product || ""}
Pack amount: ${payload.parsed?.pack_amount || ""}
Measurement: ${payload.parsed?.measurement || ""}
Price: ${payload.parsed?.price ?? ""}
Image: ${payload.parsed?.image_url || ""}`
    );

    const result = await tryAutoSubmit(payload);

    if (result?.skipped) {
      if (result.reason === "already_submitted_recently") {
        setStatus("Already submitted recently for this page.");
      } else if (result.reason === "submission_in_progress") {
        setStatus("A submission is already in progress for this page.");
      } else if (result.reason === "cooldown_active") {
        setStatus("Recently submitted. Cooldown is still active for this page.");
      } else if (result.reason === "not_signed_in") {
        setStatus("Not signed in.");
      } else if (result.reason === "auto_submit_disabled") {
        setStatus("Auto submit is disabled.");
      } else {
        setStatus(`Skipped: ${result.reason}`);
      }
      return;
    }

    setStatus(`Submitted automatically.\n${result.issueUrl}`);
  } catch (e) {
    setStatus(String(e && e.message ? e.message : e));
  }
}

async function bootForCurrentPage(force = false) {
  const currentUrl = location.href;
  const urlChanged = currentUrl !== lastHandledUrl;

  if (!shouldShowOverlay()) {
    lastHandledUrl = currentUrl;
    lastAutoAttemptSignature = "";
    lastSeenExtractedSignature = "";
    if (overlayRoot) {
      overlayRoot.remove();
      overlayRoot = null;
    }
    return;
  }

  if (urlChanged) {
    lastHandledUrl = currentUrl;
    lastAutoAttemptSignature = "";
    lastSeenExtractedSignature = "";
  }

  await renderOverlay();

  if (!isSupportedProductPage()) {
    return;
  }

  let payload;
  try {
    payload = extractPayload();
  } catch (error) {
    setStatus(String(error && error.message ? error.message : error));
    return;
  }

  const extractedSignature = JSON.stringify({
    retailer: payload.retailer,
    product_id: payload.product_id,
    url: payload.url,
    brand: payload.parsed?.brand,
    product: payload.parsed?.product,
    size: payload.parsed?.size,
    pack_amount: payload.parsed?.pack_amount,
    measurement: payload.parsed?.measurement,
    price: payload.parsed?.price,
    image_url: payload.parsed?.image_url
  });

  if (!urlChanged && extractedSignature === lastSeenExtractedSignature) {
    return;
  }

  lastSeenExtractedSignature = extractedSignature;
  await handleAutomaticFlow();
}

function scheduleBoot(delay = 300) {
  if (bootTimer) clearTimeout(bootTimer);
  bootTimer = setTimeout(() => {
    bootForCurrentPage().catch(console.error);
  }, delay);
}

function installSpaUrlWatcher() {
  const origPushState = history.pushState;
  const origReplaceState = history.replaceState;

  history.pushState = function () {
    const result = origPushState.apply(this, arguments);
    scheduleBoot(300);
    return result;
  };

  history.replaceState = function () {
    const result = origReplaceState.apply(this, arguments);
    scheduleBoot(300);
    return result;
  };

  window.addEventListener("popstate", () => {
    scheduleBoot(300);
  });

  let href = location.href;
  setInterval(() => {
    if (location.href !== href) {
      href = location.href;
      scheduleBoot(300);
    }
  }, 500);
}

function installDomWatcher() {
  if (mutationObserver) return;

  mutationObserver = new MutationObserver(() => {
    if (isSupportedProductPage()) {
      scheduleBoot(300);
    }
  });

  mutationObserver.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
}

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "EXTRACT_PAGE") {
    try {
      const payload = extractPayload();
      sendResponse({ ok: true, data: payload });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    }
    return true;
  }
});

installSpaUrlWatcher();
installDomWatcher();

window.addEventListener("load", () => {
  scheduleBoot(0);
});

setTimeout(() => scheduleBoot(200), 200);
setTimeout(() => scheduleBoot(1000), 1000);
setTimeout(() => scheduleBoot(2500), 2500);
