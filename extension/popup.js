const ext = globalThis.browser ?? globalThis.chrome;

const bodyEl = document.body;
const themeToggleEl = document.getElementById("themeToggle");

const loggedOutViewEl = document.getElementById("loggedOutView");
const loggedInViewEl = document.getElementById("loggedInView");

const loginBtnEl = document.getElementById("loginBtn");
const logoutBtnEl = document.getElementById("logoutBtn");

const userLoginEl = document.getElementById("userLogin");
const authHintEl = document.getElementById("authHint");
const deviceFlowBoxEl = document.getElementById("deviceFlowBox");
const deviceCodeEl = document.getElementById("deviceCode");
const deviceFlowUrlEl = document.getElementById("deviceFlowUrl");
const copyCodeBtnEl = document.getElementById("copyCodeBtn");
const openGithubBtnEl = document.getElementById("openGithubBtn");

const autoSubmitToggleEl = document.getElementById("autoSubmitToggle");

const extractBtnEl = document.getElementById("extractBtn");
const submitBtnEl = document.getElementById("submitBtn");

const outputEl = document.getElementById("output");
const outputLoggedOutEl = document.getElementById("outputLoggedOut");

async function sendRuntimeMessage(message) {
  return await ext.runtime.sendMessage(message);
}

async function getState() {
  const res = await sendRuntimeMessage({ type: "GET_STATE" });
  if (!res?.ok) {
    throw new Error(res?.error || "Failed to get state.");
  }
  return res.data;
}

async function setTheme(theme) {
  const res = await sendRuntimeMessage({ type: "SET_THEME", theme });
  if (!res?.ok) {
    throw new Error(res?.error || "Failed to set theme.");
  }
  return res.data;
}

async function setAutoSubmit(value) {
  const res = await sendRuntimeMessage({ type: "SET_AUTO_SUBMIT", value });
  if (!res?.ok) {
    throw new Error(res?.error || "Failed to set auto submit.");
  }
  return res.data;
}

async function startLogin() {
  const res = await sendRuntimeMessage({ type: "START_GITHUB_LOGIN" });
  if (!res?.ok) {
    throw new Error(res?.error || "Login failed.");
  }
  return res.data;
}

async function signOut() {
  const res = await sendRuntimeMessage({ type: "SIGN_OUT" });
  if (!res?.ok) {
    throw new Error(res?.error || "Sign out failed.");
  }
  return res.data;
}

async function getActiveTab() {
  const tabs = await ext.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0] ? tabs[0] : null;
}

async function extractCurrentPage() {
  const tab = await getActiveTab();
  if (!tab || typeof tab.id === "undefined") {
    throw new Error("No active tab found.");
  }

  const response = await ext.tabs.sendMessage(tab.id, { type: "EXTRACT_PAGE" });
  if (!response || !response.ok) {
    throw new Error(response?.error || "Could not extract page.");
  }

  return response.data;
}

async function submitPayload(payload) {
  const res = await sendRuntimeMessage({ type: "SUBMIT_PAYLOAD", payload });
  if (!res?.ok) {
    throw new Error(res?.error || "Submit failed.");
  }
  return res.data;
}

function setOutput(text, loggedOut = false) {
  if (loggedOut) {
    outputLoggedOutEl.textContent = text || "";
    outputLoggedOutEl.classList.toggle("hidden", !text);
    return;
  }

  outputEl.textContent = text || "";
}

function applyTheme(theme) {
  const nextTheme = theme === "light" ? "light" : "dark";
  bodyEl.setAttribute("data-theme", nextTheme);
  themeToggleEl.textContent = nextTheme === "light" ? "☾" : "☀";
  themeToggleEl.title = nextTheme === "light" ? "Switch to dark mode" : "Switch to light mode";
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    return false;
  }
}

function renderDeviceFlow(state) {
  const show = state.authStatus === "waiting_for_authorization" && !!state.pendingUserCode;

  deviceFlowBoxEl.classList.toggle("hidden", !show);

  if (!show) {
    deviceCodeEl.textContent = "......";
    deviceFlowUrlEl.textContent = "";
    authHintEl.classList.add("hidden");
    authHintEl.textContent = "";
    return;
  }

  deviceCodeEl.textContent = state.pendingUserCode || "";
  deviceFlowUrlEl.textContent = state.pendingVerificationUri
    ? `Open ${state.pendingVerificationUri} and paste the code above.`
    : "Open GitHub device activation and paste the code above.";

  authHintEl.textContent = "GitHub is waiting for you to enter the code.";
  authHintEl.classList.remove("hidden");
}

function setLoggedInUi(state) {
  const signedIn = !!(state.githubAccessToken && state.githubUserLogin);

  loggedOutViewEl.classList.toggle("hidden", signedIn);
  loggedInViewEl.classList.toggle("hidden", !signedIn);

  applyTheme(state.theme || "dark");

  if (!signedIn) {
    renderDeviceFlow(state);
    return;
  }

  userLoginEl.textContent = state.githubUserLogin || "";
  autoSubmitToggleEl.checked = state.autoSubmit !== false;

  deviceFlowBoxEl.classList.add("hidden");
  authHintEl.classList.add("hidden");
  authHintEl.textContent = "";
}

async function refreshUi() {
  const state = await getState();
  setLoggedInUi(state);

  if (state.lastSubmissionResult?.issueUrl) {
    setOutput(`Last submitted:\n${state.lastSubmissionResult.issueUrl}`);
  } else if (!outputEl.textContent.trim()) {
    setOutput("Waiting.");
  }
}

themeToggleEl.addEventListener("click", async () => {
  try {
    const state = await getState();
    const nextTheme = state.theme === "light" ? "dark" : "light";
    await setTheme(nextTheme);
    await refreshUi();
  } catch (e) {
    setOutput(String(e && e.message ? e.message : e));
  }
});

loginBtnEl.addEventListener("click", async () => {
  try {
    setOutput("Starting GitHub sign in...", true);

    startLogin().catch(err => {
      setOutput(String(err && err.message ? err.message : err), true);
      refreshUi().catch(() => {});
    });

    setTimeout(() => {
      refreshUi().catch(() => {});
    }, 300);

    const poll = setInterval(async () => {
      try {
        const state = await getState();
        setLoggedInUi(state);

        if (state.githubAccessToken && state.githubUserLogin) {
          clearInterval(poll);
          setOutput(`Signed in as ${state.githubUserLogin}`);
          await refreshUi();
          return;
        }

        if (state.authStatus === "signed_out" && !state.pendingUserCode) {
          clearInterval(poll);
          await refreshUi();
        }
      } catch (e) {
        clearInterval(poll);
      }
    }, 1500);
  } catch (e) {
    setOutput(String(e && e.message ? e.message : e), true);
  }
});

logoutBtnEl.addEventListener("click", async () => {
  try {
    await signOut();
    await refreshUi();
    setOutput("Signed out.");
  } catch (e) {
    setOutput(String(e && e.message ? e.message : e));
  }
});

copyCodeBtnEl.addEventListener("click", async () => {
  const state = await getState();
  const code = state.pendingUserCode || "";
  if (!code) return;

  const ok = await copyText(code);
  setOutput(ok ? "Code copied to clipboard." : "Could not copy code automatically.", true);
});

openGithubBtnEl.addEventListener("click", async () => {
  const state = await getState();
  const url = state.pendingVerificationUri || "https://github.com/login/device";
  await ext.tabs.create({ url });
});

autoSubmitToggleEl.addEventListener("change", async () => {
  try {
    await setAutoSubmit(autoSubmitToggleEl.checked);
    setOutput(autoSubmitToggleEl.checked ? "Auto submit enabled." : "Auto submit disabled.");
  } catch (e) {
    setOutput(String(e && e.message ? e.message : e));
  }
});

extractBtnEl.addEventListener("click", async () => {
  try {
    const payload = await extractCurrentPage();
    setOutput(JSON.stringify(payload, null, 2));
  } catch (e) {
    setOutput(String(e && e.message ? e.message : e));
  }
});

submitBtnEl.addEventListener("click", async () => {
  try {
    const payload = await extractCurrentPage();
    const result = await submitPayload(payload);
    setOutput(`Submitted successfully.\n\nIssue: ${result.html_url}`);
    await refreshUi();
  } catch (e) {
    setOutput(String(e && e.message ? e.message : e));
  }
});

refreshUi().catch(err => {
  setOutput(String(err && err.message ? err.message : err));
});