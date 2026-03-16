async function getCurrentTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function extractFromPage() {
  const tab = await getCurrentTab();
  const response = await chrome.tabs.sendMessage(tab.id, { type: "EXTRACT_PAGE" });
  if (!response?.ok) {
    throw new Error(response?.error || "Extraction failed");
  }
  return response.data;
}

async function uploadPayload(payload) {
  const res = await fetch("https://your-api.example.com/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Upload failed");
  return data;
}

const status = document.getElementById("status");

document.getElementById("extract").addEventListener("click", async () => {
  try {
    const payload = await extractFromPage();
    status.textContent = JSON.stringify(payload.parsed, null, 2);
  } catch (e) {
    status.textContent = String(e);
  }
});

document.getElementById("upload").addEventListener("click", async () => {
  try {
    const payload = await extractFromPage();
    const result = await uploadPayload(payload);
    status.textContent = JSON.stringify(result, null, 2);
  } catch (e) {
    status.textContent = String(e);
  }
});