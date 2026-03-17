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
  lastSubmittedByUrl: {},
  lastSubmissionResult: null
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
    "authStatus",
    "pendingUserCode",
    "pendingVerificationUri"
  ]);

  await ext.storage.local.set({
    githubAccessToken: "",
    githubUserLogin: "",
    authStatus: "signed_out",
    pendingUserCode: "",
    pendingVerificationUri: ""
  });
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
    const msg =
      typeof data === "object" && data && data.message
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
    throw new Error(data.error_description || data.error || "Failed to start GitHub device flow.");
  }

  return data;
}

async function pollForAccessToken(deviceCode, intervalSeconds) {
  let interval = Number(intervalSeconds) || 5;

  while (true) {
    await sleep(interval * 1000);

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
      interval += 5;
      continue;
    }

    if (data.error === "expired_token") {
      throw new Error("GitHub login expired. Please try again.");
    }

    throw new Error(data.error_description || data.error || "GitHub sign in failed.");
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
  await setState({
    authStatus: "starting_login",
    pendingUserCode: "",
    pendingVerificationUri: ""
  });

  const device = await startDeviceFlow();

  await setState({
    authStatus: "waiting_for_authorization",
    pendingUserCode: device.user_code || "",
    pendingVerificationUri: device.verification_uri || ""
  });

  if (device.verification_uri) {
    try {
      await ext.tabs.create({ url: device.verification_uri });
    } catch (e) {
      console.error("Could not open GitHub activation page", e);
    }
  }

  try {
    const accessToken = await pollForAccessToken(device.device_code, device.interval || 5);
    const user = await fetchGitHubUser(accessToken);

    await setState({
      githubAccessToken: accessToken,
      githubUserLogin: user.login,
      authStatus: "signed_in",
      pendingUserCode: "",
      pendingVerificationUri: ""
    });

    return {
      login: user.login,
      justSignedIn: true
    };
  } catch (err) {
    await setState({
      authStatus: "signed_out",
      pendingUserCode: "",
      pendingVerificationUri: ""
    });
    throw err;
  }
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

  return issue;
}

function getSubmissionSignature(payload) {
  return JSON.stringify({
    retailer: payload?.retailer || "",
    product_id: payload?.product_id || "",
    url: payload?.url || "",
    brand: payload?.parsed?.brand || "",
    product: payload?.parsed?.product || "",
    size: payload?.parsed?.size || "",
    price: payload?.parsed?.price ?? null
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
  const signature = getSubmissionSignature(payload);

  if (lastSubmittedByUrl[key] === signature) {
    return { skipped: true, reason: "already_submitted_recently" };
  }

  const result = await submitPayload(payload);
  lastSubmittedByUrl[key] = signature;

  await setState({
    lastSubmittedByUrl,
    lastSubmissionResult: {
      ok: true,
      url: payload.url,
      issueUrl: result.html_url,
      submittedAt: new Date().toISOString(),
      retailer: payload.retailer,
      productId: payload.product_id
    }
  });

  try {
    await ext.notifications.create({
      type: "basic",
      title: "Australian Supermarket Database",
      message: `Submitted ${payload.retailer} ${payload.product_id}`
    });
  } catch (e) {}

  return {
    skipped: false,
    issueUrl: result.html_url
  };
}

ext.runtime.onInstalled.addListener(async () => {
  const state = await getState();
  await setState({
    theme: state.theme || "dark",
    autoSubmit: typeof state.autoSubmit === "boolean" ? state.autoSubmit : true
  });
});

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "GET_STATE") {
        sendResponse({ ok: true, data: await getState() });
        return;
      }

      if (msg?.type === "START_GITHUB_LOGIN") {
        sendResponse({ ok: true, data: await signInWithGitHub() });
        return;
      }

      if (msg?.type === "SIGN_OUT") {
        await clearAuth();
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === "SET_THEME") {
        const theme = msg.theme === "light" ? "light" : "dark";
        await setState({ theme });
        sendResponse({ ok: true, data: { theme } });
        return;
      }

      if (msg?.type === "SET_AUTO_SUBMIT") {
        const autoSubmit = !!msg.value;
        await setState({ autoSubmit });
        sendResponse({ ok: true, data: { autoSubmit } });
        return;
      }

      if (msg?.type === "SUBMIT_PAYLOAD") {
        const issue = await submitPayload(msg.payload);
        await setState({
          lastSubmissionResult: {
            ok: true,
            url: msg.payload?.url || "",
            issueUrl: issue.html_url,
            submittedAt: new Date().toISOString(),
            retailer: msg.payload?.retailer || "",
            productId: msg.payload?.product_id || ""
          }
        });
        sendResponse({ ok: true, data: issue });
        return;
      }

      if (msg?.type === "PAGE_READY_FOR_AUTO_SUBMIT") {
        const result = await maybeAutoSubmit(msg.payload);
        sendResponse({ ok: true, data: result });
        return;
      }

      sendResponse({ ok: false, error: "Unknown message type." });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  })();

  return true;
});