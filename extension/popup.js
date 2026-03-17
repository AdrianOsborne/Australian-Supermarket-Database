const ext = globalThis.browser ?? globalThis.chrome;
const outputEl = document.getElementById("output");

async function getActiveTab() {
  const tabs = await ext.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function extractCurrentPage() {
  const tab = await getActiveTab();
  const response = await ext.tabs.sendMessage(tab.id, { type: "EXTRACT_PAGE" });
  if (!response || !response.ok) {
    throw new Error(response?.error || "Could not extract page");
  }
  return response.data;
}

async function getSettings() {
  return await ext.storage.local.get({
    githubToken: "",
    repoOwner: "AdrianOsborne",
    repoName: "AU-Supermarket-Backend"
  });
}

function formatIssueTitle(payload) {
  return `[SUBMISSION] ${payload.retailer} ${payload.product_id}`;
}

async function submitToGitHub(payload) {
  const settings = await getSettings();

  if (!settings.githubToken) {
    throw new Error("No GitHub token found. Open extension settings and add one.");
  }

  const issueBody = JSON.stringify(payload, null, 2);

  const res = await fetch(
    `https://api.github.com/repos/${settings.repoOwner}/${settings.repoName}/issues`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${settings.githubToken}`,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        title: formatIssueTitle(payload),
        body: issueBody
      })
    }
  );

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.message || "GitHub issue creation failed");
  }

  return data;
}

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
