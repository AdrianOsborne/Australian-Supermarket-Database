const ext = globalThis.browser ?? globalThis.chrome;

const PANEL_ID = "asd-auto-panel-root";
let lastSeenUrl = location.href;
let lastAutoAttemptKey = "";

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

async function getState() {
  const response = await ext.runtime.sendMessage({ type: "GET_STATE" });
  if (!response?.ok) {
    throw new Error(response?.error || "Failed to get extension state.");
  }
  return response.data;
}

function isSupportedProductPage() {
  const retailer = getRetailer();
  const productId = getProductId(retailer, location.href);
  return !!(retailer && productId);
}

function panelHtml() {
  return `
    <div class="asd-panel" data-theme="dark">
      <div class="asd-panel-head">
        <div>
          <div class="asd-title">Australian Supermarket Database</div>
          <div class="asd-subtitle">Sign in with GitHub to enable automatic submission</div>
        </div>
        <button class="asd-theme-btn" type="button" title="Toggle theme">☀</button>
      </div>
      <div class="asd-meta"></div>
      <div class="asd-actions">
        <button class="asd-login-btn" type="button">Sign in with GitHub</button>
        <button class="asd-open-btn" type="button">Open extension</button>
      </div>
      <div class="asd-status"></div>
    </div>
  `;
}

function panelCss() {
  return `
    #${PANEL_ID} {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 2147483647;
      font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    #${PANEL_ID} .asd-panel {
      width: min(360px, calc(100vw - 32px));
      border-radius: 18px;
      padding: 14px;
      box-shadow: 0 18px 40px rgba(0, 0, 0, 0.28);
      border: 1px solid #2d3442;
      background: linear-gradient(180deg, #171a21, #1d212b);
      color: #f3f6fc;
    }
    #${PANEL_ID} .asd-panel[data-theme="light"] {
      border-color: #d8e0ee;
      background: linear-gradient(180deg, #ffffff, #f7f9fc);
      color: #18202c;
      box-shadow: 0 14px 34px rgba(14, 29, 54, 0.12);
    }
    #${PANEL_ID} .asd-panel-head {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: flex-start;
      margin-bottom: 10px;
    }
    #${PANEL_ID} .asd-title {
      font-size: 14px;
      font-weight: 800;
      line-height: 1.2;
    }
    #${PANEL_ID} .asd-subtitle,
    #${PANEL_ID} .asd-meta,
    #${PANEL_ID} .asd-status {
      font-size: 12px;
      line-height: 1.45;
      opacity: 0.88;
      white-space: pre-wrap;
    }
    #${PANEL_ID} .asd-meta {
      margin-bottom: 10px;
    }
    #${PANEL_ID} .asd-status {
      margin-top: 10px;
    }
    #${PANEL_ID} .asd-actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    #${PANEL_ID} button {
      appearance: none;
      border-radius: 12px;
      min-height: 38px;
      border: 1px solid transparent;
      cursor: pointer;
      font: inherit;
      font-weight: 700;
      transition: transform 0.12s ease, opacity 0.12s ease;
    }
    #${PANEL_ID} button:hover {
      transform: translateY(-1px);
    }
    #${PANEL_ID} .asd-login-btn {
      background: linear-gradient(180deg, #6ea8fe, #3d7df7);
      color: white;
    }
    #${PANEL_ID} .asd-open-btn,
    #${PANEL_ID} .asd-theme-btn {
      background: transparent;
      border-color: rgba(127, 140, 161, 0.45);
      color: inherit;
    }
    #${PANEL_ID} .asd-theme-btn {
      width: 40px;
      min-width: 40px;
      padding: 0;
    }
  `;
}

function ensurePanel() {
  let root = document.getElementById(PANEL_ID);
  if (!root) {
    root = document.createElement("div");
    root.id = PANEL_ID;
    const shadow = root.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = panelCss();
    const wrapper = document.createElement("div");
    wrapper.innerHTML = panelHtml();
    shadow.append(style, wrapper);
    document.documentElement.appendChild(root);
  }
  return root;
}

async function updateInjectedPanel() {
  const root = ensurePanel();
  const shadow = root.shadowRoot;
  if (!shadow) return;

  const panel = shadow.querySelector(".asd-panel");
  const meta = shadow.querySelector(".asd-meta");
  const status = shadow.querySelector(".asd-status");
  const loginBtn = shadow.querySelector(".asd-login-btn");
  const openBtn = shadow.querySelector(".asd-open-btn");
  const themeBtn = shadow.querySelector(".asd-theme-btn");

  const state = await getState();
  const payload = isSupportedProductPage() ? extractPayload() : null;

  panel.setAttribute("data-theme", state.theme === "light" ? "light" : "dark");
  themeBtn.textContent = state.theme === "light" ? "☾" : "☀";

  if (!payload) {
    meta.textContent = "This page does not look like a supported product page.";
    status.textContent = "";
    loginBtn.style.display = "none";
    openBtn.style.display = "none";
    return;
  }

  meta.textContent = `${payload.retailer.toUpperCase()}\n${payload.parsed?.brand || "Unknown brand"}\n${payload.parsed?.product || payload.title || "Unknown product"}`;

  if (state.githubAccessToken && state.githubUserLogin) {
    loginBtn.style.display = "none";
    status.textContent = `Signed in as ${state.githubUserLogin}. Automatic submission is ${state.autoSubmit ? "enabled" : "disabled"}.`;
  } else if (state.authStatus === "waiting_for_authorization" && state.pendingVerificationUri && state.pendingUserCode) {
    loginBtn.style.display = "";
    status.textContent = `Finish sign in at ${state.pendingVerificationUri} using code ${state.pendingUserCode}.`;
    loginBtn.textContent = "Finish GitHub sign in";
  } else {
    loginBtn.style.display = "";
    loginBtn.textContent = "Sign in with GitHub";
    status.textContent = "You are not signed in. Sign in to enable automatic extraction and submission.";
  }

  loginBtn.onclick = async () => {
    try {
      status.textContent = "Starting GitHub sign in...";
      const response = await ext.runtime.sendMessage({ type: "START_GITHUB_LOGIN" });
      if (!response?.ok) {
        throw new Error(response?.error || "GitHub sign in failed.");
      }
      status.textContent = `Signed in successfully as ${response.data.login}.`;
      await updateInjectedPanel();
      await maybeAutoSubmitCurrentPage(true);
    } catch (e) {
      status.textContent = String(e);
    }
  };

  openBtn.onclick = async () => {
    try {
      await ext.runtime.sendMessage({ type: "GET_STATE" });
      if (ext.runtime.openOptionsPage) {
        await ext.runtime.openOptionsPage();
      }
    } catch (e) {}
  };

  themeBtn.onclick = async () => {
    try {
      const nextTheme = state.theme === "light" ? "dark" : "light";
      await ext.runtime.sendMessage({ type: "SET_THEME", theme: nextTheme });
      await updateInjectedPanel();
    } catch (e) {
      status.textContent = String(e);
    }
  };
}

async function maybeAutoSubmitCurrentPage(force = false) {
  if (!isSupportedProductPage()) return;

  const payload = extractPayload();
  const attemptKey = `${payload.url}|${payload.product_id}|${payload.parsed?.price ?? ""}`;
  if (!force && lastAutoAttemptKey === attemptKey) {
    return;
  }
  lastAutoAttemptKey = attemptKey;

  try {
    const response = await ext.runtime.sendMessage({ type: "AUTO_SUBMIT_PAYLOAD", payload });
    const root = document.getElementById(PANEL_ID);
    const status = root?.shadowRoot?.querySelector(".asd-status");
    if (!response?.ok) {
      if (status) status.textContent = String(response?.error || "Automatic submission failed.");
      return;
    }

    if (status) {
      if (response.data?.skipped) {
        const map = {
          not_signed_in: "You are not signed in. Automatic submission is waiting for GitHub login.",
          auto_submit_disabled: "Automatic submission is disabled in the extension popup.",
          invalid_payload: "This page could not be parsed into a valid payload yet.",
          already_submitted_recently: "This product was already submitted recently from this page."
        };
        status.textContent = map[response.data.reason] || `Skipped: ${response.data.reason}`;
      } else {
        status.textContent = `Submitted automatically. ${response.data.issueUrl}`;
      }
    }
  } catch (e) {
    const root = document.getElementById(PANEL_ID);
    const status = root?.shadowRoot?.querySelector(".asd-status");
    if (status) status.textContent = String(e);
  }
}

function schedulePageChecks() {
  const run = async () => {
    if (location.href !== lastSeenUrl) {
      lastSeenUrl = location.href;
      lastAutoAttemptKey = "";
    }

    if (isSupportedProductPage()) {
      await updateInjectedPanel();
      await maybeAutoSubmitCurrentPage(false);
    } else {
      const existing = document.getElementById(PANEL_ID);
      if (existing) existing.remove();
    }
  };

  run().catch(() => {});
  setInterval(() => run().catch(() => {}), 1500);
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

ext.storage.onChanged.addListener(() => {
  updateInjectedPanel().catch(() => {});
});

schedulePageChecks();
