const ext = globalThis.browser ?? globalThis.chrome;
const outputEl = document.getElementById("output");
const statusLineEl = document.getElementById("statusLine");

const GITHUB_CLIENT_ID = "REPLACE_WITH_YOUR_GITHUB_OAUTH_APP_CLIENT_ID";
const REPO_OWNER = "AdrianOsborne";
const REPO_NAME = "AU-Supermarket-Backend";
const ISSUE_TITLE_PREFIX = "[SUBMISSION]";
const GITHUB_SCOPE = "repo";

async function getStoredAuth() {
  return await ext.storage.local.get({
    githubAccessToken: "",
    githubUserLogin: ""
  });
}

async function setStoredAuth(accessToken, userLogin) {
  await ext.storage.local.set({
    githubAccessToken: accessToken,
    githubUserLogin: userLogin
  });
}

async function clearStoredAuth() {
  await ext.storage.local.remove(["githubAccessToken", "githubUserLogin"]);
}

async function updateStatusLine() {
  const auth = await getStoredAuth();
  if (auth.githubAccessToken && auth.githubUserLogin) {
    statusLineEl.textContent = `Signed in as ${auth.githubUserLogin}`;
  } else {
    statusLineEl.textContent = "Not signed in";
  }
}

async function githubApi(url, options = {}) {
  const auth = await getStoredAuth();
  if (!auth.githubAccessToken) {
    throw new Error("Not signed in with GitHub.");
  }

  const headers = {
    "Authorization": `Bearer ${auth.githubAccessToken}`,
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
  outputEl.textContent = "Starting GitHub sign-in...";

  const device = await startDeviceFlow();

  outputEl.textContent =
    `Go to:\n${device.verification_uri}\n\n` +
    `Then enter this code:\n${device.user_code}\n\n` +
    `Waiting for authorization...`;

  if (device.verification_uri) {
    try {
      await ext.tabs.create({ url: device.verification_uri });
    } catch (e) {}
  }

  const accessToken = await pollForAccessToken(device.device_code, device.interval || 5);
  const user = await fetchGitHubUser(accessToken);

  await setStoredAuth(accessToken, user.login);
  await updateStatusLine();

  outputEl.textContent = `Signed in successfully as ${user.login}`;
}

async function signOutGitHub() {
  await clearStoredAuth();
  await updateStatusLine();
  outputEl.textContent = "Signed out.";
}

async function getActiveTab() {
  const tabs = await ext.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function extractCurrentPage() {
  const tab = await getActiveTab();
  const response = await ext.tabs.sendMessage(tab.id, { type: "EXTRACT_PAGE" });

  if (!response || !response.ok) {
    throw new Error(response?.error || "Could not extract page.");
  }

  return response.data;
}

function formatIssueTitle(payload) {
  return `${ISSUE_TITLE_PREFIX} ${payload.retailer} ${payload.product_id}`;
}

async function submitToGitHub(payload) {
  return await githubApi(
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
}

document.getElementById("loginBtn").addEventListener("click", async () => {
  try {
    await signInWithGitHub();
  } catch (e) {
    outputEl.textContent = String(e);
  }
});

document.getElementById("logoutBtn").addEventListener("click", async () => {
  try {
    await signOutGitHub();
  } catch (e) {
    outputEl.textContent = String(e);
  }
});

document.getElementById("extractBtn").addEventListener("click", async () => {
  try {
    const payload = await extractCurrentPage();
    outputEl.textContent = JSON.stringify(payload, null, 2);
  } catch (e) {
    outputEl.textContent = String(e);
  }
});

document.getElementById("submitBtn").addEventListener("click", async () => {
  try {
    const payload = await extractCurrentPage();
    const result = await submitToGitHub(payload);
    outputEl.textContent = `Submitted successfully.\n\nIssue: ${result.html_url}`;
  } catch (e) {
    outputEl.textContent = String(e);
  }
});

updateStatusLine();
