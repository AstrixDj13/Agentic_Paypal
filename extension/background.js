// Sends shopping signals from content scripts to the paired Pocket server.
// Never runs in incognito (manifest), and does nothing until paired or while paused.

const get = (keys) => chrome.storage.local.get(keys);

async function post(server, path, body, token) {
  const res = await fetch(`${server.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Pocket said ${res.status}`);
  return json;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    if (msg.type === "signal") {
      if (sender.tab?.incognito) return;
      const { server, token, paused } = await get(["server", "token", "paused"]);
      if (!server || !token || paused) return;
      try {
        const r = await post(server, "/api/intel/signals", { signals: [msg.signal] }, token);
        if (r.kept) {
          const { recent = [] } = await get(["recent"]);
          const label = msg.signal.kind === "search" ? `Searched “${msg.signal.query}”` : msg.signal.title;
          const next = [{ label, domain: msg.signal.domain, at: Date.now() }, ...recent.filter((x) => x.label !== label)].slice(0, 8);
          await chrome.storage.local.set({ recent: next, lastError: "" });
        }
      } catch (e) {
        await chrome.storage.local.set({ lastError: String(e.message || e) });
      }
    }
    if (msg.type === "pair") {
      try {
        const { token } = await post(msg.server, "/api/intel/pair", { code: msg.code, label: "Chrome" });
        await chrome.storage.local.set({ server: msg.server, token, paused: false, recent: [], lastError: "" });
        reply({ ok: true });
      } catch (e) {
        reply({ ok: false, error: String(e.message || e) });
      }
    }
  })();
  return msg.type === "pair"; // keep the channel open for the async pair reply
});
