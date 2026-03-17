const ext = globalThis.browser ?? globalThis.chrome;

const githubTokenEl = document.getElementById("githubToken");
const repoOwnerEl = document.getElementById("repoOwner");
const repoNameEl = document.getElementById("repoName");
const statusEl = document.getElementById("status");

async function loadSettings() {
  const data = await ext.storage.local.get({
    githubToken: "",
    repoOwner: "AdrianOsborne",
    repoName: "AU-Supermarket-Backend"
  });

  githubTokenEl.value = data.githubToken || "";
  repoOwnerEl.value = data.repoOwner || "AdrianOsborne";
  repoNameEl.value = data.repoName || "AU-Supermarket-Backend";
}

async function saveSettings() {
  await ext.storage.local.set({
    githubToken: githubTokenEl.value.trim(),
    repoOwner: repoOwnerEl.value.trim(),
    repoName: repoNameEl.value.trim()
  });
  statusEl.textContent = "Saved.";
}

document.getElementById("saveBtn").addEventListener("click", saveSettings);
loadSettings();
