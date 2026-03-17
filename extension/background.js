const ext = globalThis.browser ?? globalThis.chrome;

const GITHUB_CLIENT_ID = "Ov23liNl0shL2OPigKeG";
const REPO_OWNER = "AdrianOsborne";
const REPO_NAME = "AU-Supermarket-Backend";
const ISSUE_TITLE_PREFIX = "[SUBMISSION]";
const GITHUB_SCOPE = "repo";
const DEFAULT_STATE = {
  githubAccessToken: "",
  githubUserLogin: "",
  theme: "dark",
  autoSubmit: true,
  authStatus: "signed_out",
  pendingUserCode: "",
  pendingVerificationUri: "",
  pendingAuthStartedAt: "",
  lastSubmittedByUrl: {},
  lastSubmissionResult: null
};

async function getState() {
  return await ext.storage.local.get(DEFAULT_STATE);
}

async function setState(patch) {
  await ext.storage.local.set(patch);
}

async function clearAuth() {
  await ext.storage.local.remove([
    "githubAccessToken",
    "githubUserLogin",
    "pendingUserCode",
    "pendingVerificationUri",
    "pendingAuthStartedAt"
  ]);
}

async function githubApi(url, options = {}) {
  const state = await getState();
  if (!state.githubAccessToken) {
    throw new Error("Not signed in with GitHub.");
  }

  const headers = {
    Authorization: `Bearer ${state.githubAccessToken}`,
    Accept: "application/vnd.github+json",
    ...(options.headers || {})
  };

  const res = await fetch(url, {
    ...options,
    headers
  });

  const contentType = res.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await res.json()
    : await res.text();

  if (!res.ok) {
    const message = typeof data === "object" && data && data.message
      ? data.message
      : `GitHub request failed with status ${res.status}`;
    throw new Error(message);
  }

  return data;
}

async function startDeviceFlow() {
  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      scope: GITHUB_SCOPE
    })
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error_description || data.error || "Failed to start device flow.");
  }
  return data;
}

async function pollForAccessToken(deviceCode, intervalSeconds) {
  while (true) {
    await new Promise(resolve => setTimeout(resolve, intervalSeconds * 1000));

    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        client_id: GITHUB_CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code"
      })
    });

    const data = await res.json();

    if (data.access_token) {
      return data.access_token;
    }

    if (data.error === "authorization_pending") {
      continue;
    }

    if (data.error === "slow_down") {
      intervalSeconds += 5;
      continue;
    }

    throw new Error(data.error_description || data.error || "GitHub sign in failed.");
  }
}

async function fetchGitHubUser(accessToken) {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json"
    }
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || "Failed to fetch GitHub user.");
  }
  return data;
}

async function signInWithGitHub() {
  const device = await startDeviceFlow();

  await setState({
    authStatus: "waiting_for_authorization",
    pendingUserCode: device.user_code || "",
    pendingVerificationUri: device.verification_uri || "",
    pendingAuthStartedAt: new Date().toISOString()
  });

  if (device.verification_uri) {
    try {
      await ext.tabs.create({ url: device.verification_uri });
    } catch (e) {}
  }

  const accessToken = await pollForAccessToken(device.device_code, device.interval || 5);
  const user = await fetchGitHubUser(accessToken);

  await setState({
    githubAccessToken: accessToken,
    githubUserLogin: user.login,
    authStatus: "signed_in",
    pendingUserCode: "",
    pendingVerificationUri: "",
    pendingAuthStartedAt: ""
  });

  return { login: user.login };
}

function formatIssueTitle(payload) {
  return `${ISSUE_TITLE_PREFIX} ${payload.retailer} ${payload.product_id}`;
}

async function submitPayload(payload) {
  const issue = await githubApi(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/issues`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        title: formatIssueTitle(payload),
        body: JSON.stringify(payload, null, 2)
      })
    }
  );

  await setState({
    lastSubmissionResult: {
      ok: true,
      issueUrl: issue.html_url,
      retailer: payload.retailer,
      productId: payload.product_id,
      url: payload.url,
      submittedAt: new Date().toISOString()
    }
  });

  return issue;
}

function payloadSignature(payload) {
  return JSON.stringify({
    product_id: payload?.product_id || "",
    retailer: payload?.retailer || "",
    url: payload?.url || "",
    brand: payload?.parsed?.brand || "",
    product: payload?.parsed?.product || "",
    size: payload?.parsed?.size || "",
    price: payload?.parsed?.price ?? "",
    version: payload?.extension_version || ""
  });
}

async function maybeAutoSubmit(payload) {
  const state = await getState();

  if (!state.githubAccessToken) {
    return { skipped: true, reason: "not_signed_in" };
  }
  if (!state.autoSubmit) {
    return { skipped: true, reason: "auto_submit_disabled" };
  }
  if (!payload?.retailer || !payload?.product_id || !payload?.url) {
    return { skipped: true, reason: "invalid_payload" };
  }

  const lastSubmittedByUrl = state.lastSubmittedByUrl || {};
  const key = payload.url;
  const sig = payloadSignature(payload);

  if (lastSubmittedByUrl[key] === sig) {
    return { skipped: true, reason: "already_submitted_recently" };
  }

  const result = await submitPayload(payload);
  lastSubmittedByUrl[key] = sig;

  await setState({
    lastSubmittedByUrl,
    lastSubmissionResult: {
      ok: true,
      issueUrl: result.html_url,
      retailer: payload.retailer,
      productId: payload.product_id,
      url: payload.url,
      submittedAt: new Date().toISOString()
    }
  });

  try {
    await ext.notifications.create(`submit-${Date.now()}`, {
      type: "basic",
      iconUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9s4A2x0AAAAASUVORK5CYII=",
      title: "Australian Supermarket Database",
      message: `Submitted ${payload.retailer} ${payload.product_id}`
    });
  } catch (e) {}

  return { skipped: false, issueUrl: result.html_url };
}

ext.runtime.onInstalled.addListener(async () => {
  const current = await getState();
  await setState({
    theme: current.theme || "dark",
    autoSubmit: typeof current.autoSubmit === "boolean" ? current.autoSubmit : true,
    authStatus: current.githubAccessToken ? "signed_in" : (current.authStatus || "signed_out")
  });
});

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "START_GITHUB_LOGIN") {
        const result = await signInWithGitHub();
        sendResponse({ ok: true, data: result });
        return;
      }

      if (msg?.type === "SIGN_OUT") {
        await clearAuth();
        await setState({ authStatus: "signed_out" });
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === "GET_STATE") {
        const state = await getState();
        sendResponse({ ok: true, data: state });
        return;
      }

      if (msg?.type === "SET_THEME") {
        const theme = msg.theme === "light" ? "light" : "dark";
        await setState({ theme });
        sendResponse({ ok: true, data: { theme } });
        return;
      }

      if (msg?.type === "SET_AUTO_SUBMIT") {
        await setState({ autoSubmit: !!msg.value });
        sendResponse({ ok: true, data: { autoSubmit: !!msg.value } });
        return;
      }

      if (msg?.type === "SUBMIT_PAYLOAD") {
        const result = await submitPayload(msg.payload);
        sendResponse({ ok: true, data: result });
        return;
      }

      if (msg?.type === "AUTO_SUBMIT_PAYLOAD") {
        const result = await maybeAutoSubmit(msg.payload);
        sendResponse({ ok: true, data: result });
        return;
      }

      sendResponse({ ok: false, error: "Unknown message type." });
    } catch (e) {
      await setState({
        lastSubmissionResult: {
          ok: false,
          error: String(e),
          submittedAt: new Date().toISOString()
        }
      });
      sendResponse({ ok: false, error: String(e) });
    }
  })();

  return true;
});
