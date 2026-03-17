const ext = globalThis.browser ?? globalThis.chrome;

const OVERLAY_ID = "au-supermarket-db-overlay-root";
const STYLE_ID = "au-supermarket-db-overlay-style";
const MIN_KEY = "au_supermarket_overlay_minimized";

let overlayRoot = null;
let lastHandledUrl = "";
let lastAutoAttemptSignature = "";

function cleanText(v) {
  if (!v) return null;
  return String(v).replace(/\s+/g, " ").trim() || null;
}

function getRetailer() {
  const host = location.hostname.toLowerCase();

  if (host === "www.woolworths.com.au" || host === "woolworths.com.au") return "woolworths";
  if (host === "www.coles.com.au" || host === "coles.com.au") return "coles";
  if (host === "www.aldi.com.au" || host === "aldi.com.au") return "aldi";

  return null;
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

  const url = location.href;

  if (retailer === "woolworths") {
    return /\/shop\/productdetails\/\d+/i.test(new URL(url).pathname);
  }

  if (retailer === "coles") {
    return /\/product\/.+/i.test(new URL(url).pathname);
  }

  if (retailer === "aldi") {
    return /\/product\/.+/i.test(new URL(url).pathname);
  }

  return false;
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
    } catch {}
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
      if (!Number.isNaN(parsed)) {
        price = parsed;
      }
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

  if (!productId) {
    throw new Error("Could not determine product_id from this page URL.");
  }

  return {
    retailer,
    product_id: String(productId),
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
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 180px;
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

    #${OVERLAY_ID}.au-collapsed .au-body {
      display: none;
    }

    #${OVERLAY_ID}.au-collapsed .au-card {
      width: 220px;
      padding-bottom: 10px;
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
          <div>
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
  const minimized = isMinimized();
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
  if (!isSupportedProductPage()) {
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

  const signedIn = !!(state.githubAccessToken && state.githubUserLogin);

  loggedOutView.classList.toggle("au-hidden", signedIn);
  loggedInView.classList.toggle("au-hidden", !signedIn);

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
  const signature = `${payload.url}|${payload.product_id}|${payload.parsed?.price ?? ""}`;

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
    setStatus(`Extracted product page.\nRetailer: ${payload.retailer}\nProduct ID: ${payload.product_id}\nSubmitting automatically...`);
    const result = await tryAutoSubmit(payload);

    if (result?.skipped) {
      if (result.reason === "already_submitted_recently") {
        setStatus("Already submitted recently for this page.");
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

async function bootForCurrentPage() {
  if (location.href === lastHandledUrl && overlayRoot) return;
  lastHandledUrl = location.href;
  lastAutoAttemptSignature = "";
  await renderOverlay();
  await handleAutomaticFlow();
}

function installSpaUrlWatcher() {
  const origPushState = history.pushState;
  const origReplaceState = history.replaceState;

  history.pushState = function () {
    const result = origPushState.apply(this, arguments);
    queueMicrotask(() => bootForCurrentPage().catch(console.error));
    return result;
  };

  history.replaceState = function () {
    const result = origReplaceState.apply(this, arguments);
    queueMicrotask(() => bootForCurrentPage().catch(console.error));
    return result;
  };

  window.addEventListener("popstate", () => {
    bootForCurrentPage().catch(console.error);
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
window.addEventListener("load", () => {
  bootForCurrentPage().catch(console.error);
});
setTimeout(() => bootForCurrentPage().catch(console.error), 700);
setTimeout(() => bootForCurrentPage().catch(console.error), 2000);