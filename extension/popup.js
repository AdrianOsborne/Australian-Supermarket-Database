const ext = globalThis.browser ?? globalThis.chrome;

const els = {
  body: document.body,
  loggedOutView: document.getElementById("loggedOutView"),
  loggedInView: document.getElementById("loggedInView"),
  loginBtn: document.getElementById("loginBtn"),
  logoutBtn: document.getElementById("logoutBtn"),
  themeToggle: document.getElementById("themeToggle"),
  autoSubmitToggle: document.getElementById("autoSubmitToggle"),
  userLogin: document.getElementById("userLogin"),
  output: document.getElementById("output"),
  authHint: document.getElementById("authHint"),
  extractBtn: document.getElementById("extractBtn"),
  submitBtn: document.getElementById("submitBtn")
};

async function sendMessage(message) {
  return await ext.runtime.sendMessage(message);
}

async function getState() {
  const response = await sendMessage({ type: "GET_STATE" });
  if (!response?.ok) {
    throw new Error(response?.error || "Failed to get state.");
  }
  return response.data;
}

async function getActiveTab() {
  const tabs = await ext.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function extractCurrentPage() {
  const tab = await getActiveTab();
  if (!tab?.id) {
    throw new Error("No active tab.");
  }

  const response = await ext.tabs.sendMessage(tab.id, { type: "EXTRACT_PAGE" });
  if (!response?.ok) {
    throw new Error(response?.error || "Could not extract current page.");
  }
  return response.data;
}

function setTheme(theme) {
  els.body.setAttribute("data-theme", theme === "light" ? "light" : "dark");
  els.themeToggle.textContent = theme === "light" ? "☾" : "☀";
}

function showLoggedOut() {
  els.loggedOutView.classList.remove("hidden");
  els.loggedInView.classList.add("hidden");
}

function showLoggedIn() {
  els.loggedOutView.classList.add("hidden");
  els.loggedInView.classList.remove("hidden");
}

function renderOutput(value) {
  els.output.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function renderAuthHint(state) {
  if (state.authStatus === "waiting_for_authorization" && state.pendingVerificationUri && state.pendingUserCode) {
    els.authHint.textContent = `Open ${state.pendingVerificationUri} and enter code ${state.pendingUserCode}. Waiting for approval...`;
    return;
  }
  els.authHint.textContent = "";
}

async function render() {
  const state = await getState();
  setTheme(state.theme || "dark");
  renderAuthHint(state);

  if (state.githubAccessToken && state.githubUserLogin) {
    showLoggedIn();
    els.userLogin.textContent = state.githubUserLogin;
    els.autoSubmitToggle.checked = !!state.autoSubmit;

    if (state.lastSubmissionResult) {
      renderOutput(state.lastSubmissionResult);
    } else {
      renderOutput("Ready.");
    }
  } else {
    showLoggedOut();
    renderOutput("Sign in to GitHub to submit product pages.");
  }
}

els.themeToggle.addEventListener("click", async () => {
  try {
    const state = await getState();
    const nextTheme = state.theme === "light" ? "dark" : "light";
    const response = await sendMessage({ type: "SET_THEME", theme: nextTheme });
    if (!response?.ok) throw new Error(response?.error || "Failed to set theme.");
    await render();
  } catch (e) {
    renderOutput(String(e));
  }
});

els.loginBtn.addEventListener("click", async () => {
  try {
    els.authHint.textContent = "Starting GitHub sign in...";
    renderOutput("Starting GitHub sign in...");
    const response = await sendMessage({ type: "START_GITHUB_LOGIN" });
    if (!response?.ok) throw new Error(response?.error || "GitHub sign in failed.");
    renderOutput(`Signed in successfully as ${response.data.login}`);
    await render();
  } catch (e) {
    renderOutput(String(e));
    await render();
  }
});

els.logoutBtn.addEventListener("click", async () => {
  try {
    const response = await sendMessage({ type: "SIGN_OUT" });
    if (!response?.ok) throw new Error(response?.error || "Sign out failed.");
    await render();
  } catch (e) {
    renderOutput(String(e));
  }
});

els.autoSubmitToggle.addEventListener("change", async () => {
  try {
    const response = await sendMessage({ type: "SET_AUTO_SUBMIT", value: els.autoSubmitToggle.checked });
    if (!response?.ok) throw new Error(response?.error || "Failed to save automatic submission setting.");
    await render();
  } catch (e) {
    renderOutput(String(e));
  }
});

els.extractBtn.addEventListener("click", async () => {
  try {
    const payload = await extractCurrentPage();
    renderOutput(payload);
  } catch (e) {
    renderOutput(String(e));
  }
});

els.submitBtn.addEventListener("click", async () => {
  try {
    const payload = await extractCurrentPage();
    const response = await sendMessage({ type: "SUBMIT_PAYLOAD", payload });
    if (!response?.ok) throw new Error(response?.error || "Submit failed.");
    renderOutput({
      message: "Submitted successfully.",
      issueUrl: response.data.html_url
    });
  } catch (e) {
    renderOutput(String(e));
  }
});

ext.storage.onChanged.addListener(() => {
  render().catch(() => {});
});

render().catch((e) => {
  renderOutput(String(e));
});
