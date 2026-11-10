const app = document.getElementById("app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function render() {
  const { server, token, paused, recent = [], lastError } = await chrome.storage.local.get(["server", "token", "paused", "recent", "lastError"]);

  if (!token) {
    app.innerHTML = `
      <p>Let your agents learn what you shop for. Only <strong>product pages</strong> and <strong>shopping searches</strong> are shared, never other pages, never incognito.</p>
      <label>Pocket address<input id="server" value="${esc(server || "http://localhost:8787")}" /></label>
      <label>6-digit code from Pocket<input id="code" inputmode="numeric" maxlength="6" placeholder="In Pocket: What Pocket knows → Connect browser" /></label>
      <button id="pair">Connect</button>
      <p id="msg" class="err"></p>`;
    document.getElementById("pair").onclick = async (e) => {
      e.target.disabled = true;
      const r = await chrome.runtime.sendMessage({ type: "pair", server: document.getElementById("server").value.trim(), code: document.getElementById("code").value.trim() });
      if (r?.ok) render();
      else { document.getElementById("msg").textContent = r?.error || "Couldn't connect."; e.target.disabled = false; }
    };
    return;
  }

  app.innerHTML = `
    <div class="row">
      <span class="ok ${paused ? "paused" : ""}">${paused ? "Paused" : "Learning"}</span>
      <button class="switch ${paused ? "" : "on"}" id="toggle" aria-label="Learning on or off"></button>
    </div>
    <p class="muted">Connected to ${esc(server)}. Product pages and shopping searches only.</p>
    ${lastError ? `<p class="err">${esc(lastError)}</p>` : ""}
    <strong>Recently noticed</strong>
    ${recent.length ? `<ul>${recent.map((r) => `<li><span>${esc(r.label)}</span><span class="muted">${esc(r.domain || "")}</span></li>`).join("")}</ul>` : `<p class="muted">Nothing yet. Open a product page on any shop.</p>`}
    <button class="ghost" id="open">Open What Pocket knows</button>
    <button class="ghost" id="unpair">Disconnect this browser</button>`;
  document.getElementById("toggle").onclick = async () => { await chrome.storage.local.set({ paused: !paused }); render(); };
  document.getElementById("open").onclick = () => chrome.tabs.create({ url: `${server.replace(/\/$/, "")}/knows` });
  document.getElementById("unpair").onclick = async () => { await chrome.storage.local.remove(["token", "recent", "lastError"]); render(); };
}
render();
