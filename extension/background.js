const ext = globalThis.browser ?? globalThis.chrome;

const GITHUB_CLIENT_ID = "REPLACE_WITH_YOUR_GITHUB_OAUTH_APP_CLIENT_ID";
const REPO_OWNER = "AdrianOsborne";
const REPO_NAME = "AU-Supermarket-Backend";
const ISSUE_TITLE_PREFIX = "[SUBMISSION]";
const GITHUB_SCOPE = "repo";

async function getState() {
  return await ext.storage.local.get({
    githubAccessToken: "",
    githubUserLogin: "",
    theme: "dark",
    autoSubmit: true,
    lastSubmittedByUrl: {}
  });
}

async function setState(patch) {
  await ext.storage.local.set(patch);
}

async function clearAuth() {
  await ext.storage.local.remove(["githubAccessToken", "githubUserLogin"]);
}

async function githubApi(url, options = {}) {
  const state = await getState();
  if (!state.githubAccessToken) {
    throw new Error("Not signed in with GitHub.");
  }

  const headers = {
    "Authorization": `Bearer ${state.githubAccessToken}`,
    "Accept": "application/vnd.github+json",
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
    const msg = typeof data === "object" && data && data.message
      ? data.message
      : `GitHub request failed with status ${res.status}`;
    throw new Error(msg);
  }

  return data;
}

async function startDeviceFlow() {
  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      "Accept": "application/json",
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
        "Accept": "application/json",
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

    throw new Error(data.error_description || data.error || "GitHub sign-in failed.");
  }
}

async function fetchGitHubUser(accessToken) {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Accept": "application/vnd.github+json"
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

  if (device.verification_uri) {
    await ext.tabs.create({ url: device.verification_uri });
  }

  await ext.storage.local.set({
    pendingUserCode: device.user_code,
    pendingVerificationUri: device.verification_uri,
    authStatus: "waiting_for_authorization"
  });

  const accessToken = await pollForAccessToken(device.device_code, device.interval || 5);
  const user = await fetchGitHubUser(accessToken);

  await ext.storage.local.set({
    githubAccessToken: accessToken,
    githubUserLogin: user.login,
    authStatus: "signed_in",
    pendingUserCode: "",
    pendingVerificationUri: ""
  });

  return { login: user.login };
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
        title: `${ISSUE_TITLE_PREFIX} ${payload.retailer} ${payload.product_id}`,
        body: JSON.stringify(payload, null, 2)
      })
    }
  );

  return issue;
}

async function maybeAutoSubmit(payload) {
  const state = await getState();

  if (!state.githubAccessToken) return { skipped: true, reason: "not_signed_in" };
  if (!state.autoSubmit) return { skipped: true, reason: "auto_submit_disabled" };
  if (!payload?.retailer || !payload?.product_id || !payload?.url) return { skipped: true, reason: "invalid_payload" };

  const lastSubmittedByUrl = state.lastSubmittedByUrl || {};
  const key = payload.url;
  const currentSig = `${payload.product_id}|${payload.extension_version}|${payload.parsed?.price ?? ""}`;

  if (lastSubmittedByUrl[key] === currentSig) {
    return { skipped: true, reason: "already_submitted_recently" };
  }

  const result = await submitPayload(payload);
  lastSubmittedByUrl[key] = currentSig;

  await setState({ lastSubmittedByUrl });

  try {
    await ext.notifications.create({
      type: "basic",
      iconUrl: ext.runtime.getURL(""),
      title: "Australian Supermarket Database",
      message: `Submitted ${payload.retailer} ${payload.product_id}`
    });
  } catch (e) {}

  return { skipped: false, issueUrl: result.html_url };
}

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
        await ext.storage.local.set({ authStatus: "signed_out" });
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === "GET_STATE") {
        const state = await getState();
        sendResponse({ ok: true, data: state });
        return;
      }

      if (msg?.type === "SET_THEME") {
        await setState({ theme: msg.theme === "light" ? "light" : "dark" });
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === "SET_AUTO_SUBMIT") {
        await setState({ autoSubmit: !!msg.value });
        sendResponse({ ok: true });
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
      sendResponse({ ok: false, error: String(e) });
    }
  })();

  return true;
});
