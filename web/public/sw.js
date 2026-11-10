// PayPal Pocket service worker: phone notifications from your agents.
// "Take a look before I buy" notifications carry two buttons that answer the agent directly.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let msg = {};
  try { msg = event.data ? event.data.json() : {}; } catch { msg = { title: "PayPal Pocket", body: event.data && event.data.text() }; }
  const actions = msg.look ? [{ action: "buy", title: "Looks good" }, { action: "skip", title: "Skip" }] : [];
  event.waitUntil(self.registration.showNotification(msg.title || "PayPal Pocket", {
    body: msg.body || "",
    icon: "/apple-touch-icon.png",
    badge: "/apple-touch-icon.png",
    image: msg.image,
    tag: msg.tag,
    renotify: !!msg.tag,
    requireInteraction: !!msg.look,
    actions,
    data: { url: msg.url || "/", look: msg.look || null },
  }));
});

self.addEventListener("notificationclick", (event) => {
  const n = event.notification;
  const { url, look } = n.data || {};
  n.close();
  event.waitUntil((async () => {
    if (look && (event.action === "buy" || event.action === "skip")) {
      // Skipping is always safe. "Looks good" only brings forward a purchase that is already within the rules.
      const res = await fetch(`/api/purchases/${look.purchaseId}/look`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: event.action }),
      }).catch(() => null);
      const ok = res && res.ok;
      await self.registration.showNotification(ok ? (event.action === "buy" ? "Buying it now" : "Skipped. Nothing was paid") : "Couldn't reach Pocket", {
        body: ok ? (event.action === "buy" ? "You'll get the receipt in Pocket." : "Your agent will remember you didn't want it.") : "Open Pocket to decide.",
        icon: "/apple-touch-icon.png", tag: look.purchaseId,
      });
      return;
    }
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = all.find((c) => new URL(c.url).origin === self.location.origin);
    if (open) { await open.focus(); open.navigate(url).catch(() => {}); }
    else await self.clients.openWindow(url);
  })());
});
