import { useEffect, useRef, useState } from "react";
import {
  api, fileToDataUrl, money, when, useIntel,
  type AgentPrefill, type AgentSuggestion, type AppState, type IntelView, type MandateDraft, type Purchase, type RuleTip, type Signal, type WantResult,
} from "../api";
import { disablePush, enablePush, pushState } from "../push";
import { Icon, type IconName } from "./Icon";
import { Switch } from "./ui";

/**
 * The intelligence layer, in the UI: what Pocket has learned (and the controls to see, pause
 * and delete it), suggestions with their reasons, "take a look before I buy", snap-to-want,
 * and tips while writing a rule. Suggestions never change anything until you approve.
 */

type Show = (t: string, e?: boolean, action?: { label: string; run: () => void }) => void;
const cap = (s?: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");

/* ------------------------------------ Take a look before I buy ------------------------------------ */

function useCountdown(until?: string) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, []);
  const left = until ? Math.max(0, Date.parse(until) - now) : 0;
  const s = Math.ceil(left / 1000);
  return { left, text: s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${s}s` };
}

/** A purchase the agent is about to make: photo, price, a countdown, and "Looks good" / "Skip". */
export function LookCard({ state, p, answer: send }: { state: AppState; p: Purchase; answer: (decision: "buy" | "skip") => Promise<unknown> }) {
  const product = state.products.find((x) => x.id === p.productId);
  const { left, text } = useCountdown(p.lookUntil);
  const [busy, setBusy] = useState(false);
  const answer = async (decision: "buy" | "skip") => { setBusy(true); try { await send(decision); } finally { setBusy(false); } };
  const total = p.lookUntil ? Math.max(1, Date.parse(p.lookUntil) - Date.parse(p.createdAt)) : 1;
  return (
    <div className="look-card">
      <div className="look-top">
        {product?.imageUrl ? <img src={product.imageUrl} alt="" /> : <span className="look-ph"><Icon name="store" size={26} /></span>}
        <span className="grow stack-xs">
          <span className="caption muted">Take a look before I buy</span>
          <strong className="headline clamp-2">{p.title}</strong>
          <span className="row" style={{ gap: 8 }}><span className="num">{money(p.total)}</span>{product?.source?.domain && <span className="caption muted">{product.source.domain}</span>}</span>
        </span>
      </div>
      {p.why && <p className="footnote muted">{p.why}</p>}
      <div className="look-timer" aria-live="polite">
        <span className="look-bar"><i style={{ transform: `scaleX(${left / total})` }} /></span>
        <span className="caption">{left > 0 ? `Buying in ${text} unless you skip` : "Buying now…"}</span>
      </div>
      <div className="action-pair">
        <button className="btn tonal" disabled={busy} onClick={() => answer("skip")}><Icon name="close" size={18} />Skip</button>
        <button className="btn primary" disabled={busy} onClick={() => answer("buy")}><Icon name="check" size={18} />Looks good</button>
      </div>
    </div>
  );
}

/** "Show me before buying" setting for one agent. */
export const LOOK_OPTIONS: { value: string; label: string }[] = [
  { value: "0", label: "Off" }, { value: "60", label: "1 min" }, { value: "300", label: "5 min" }, { value: "1800", label: "30 min" },
];

/* ------------------------------------ Suggestions ------------------------------------ */

export function SuggestionCard({ s, onUse, onDismiss, compact }: { s: AgentSuggestion; onUse: (p: AgentPrefill) => void; onDismiss?: () => void; compact?: boolean }) {
  return (
    <div className={`suggest-card ${compact ? "compact" : ""}`}>
      {s.imageUrl ? <img src={s.imageUrl} alt="" /> : <span className="look-ph"><Icon name="sparkles" size={22} /></span>}
      <span className="grow stack-xs">
        <strong className="headline clamp-2">{s.title}</strong>
        <span className="footnote muted">{s.why}</span>
        <span className="row" style={{ gap: 8, marginTop: 4 }}>
          <button className="btn sm primary" onClick={() => onUse({ instruction: s.instruction, amount: s.amount, why: s.why })}><Icon name="plus" size={14} />Make an agent</button>
          {onDismiss && <button className="btn sm ghost" onClick={onDismiss}>Not interested</button>}
        </span>
      </span>
    </div>
  );
}

/** Home: "Pocket noticed" (top suggestion) plus a way into What Pocket knows. */
export function NoticedCard({ onUse, onOpenKnows, onSnap }: { onUse: (p: AgentPrefill) => void; onOpenKnows: () => void; onSnap: () => void }) {
  const { intel, refresh } = useIntel(6000);
  const top = intel?.suggestions[0];
  return (
    <section className="stack-sm">
      <div className="section-head">
        <h2 className="section-title">Pocket noticed</h2>
        <button className="btn sm ghost" onClick={onOpenKnows}>What Pocket knows</button>
      </div>
      {top ? (
        <SuggestionCard s={top} onUse={onUse} onDismiss={async () => { await api("/api/intel/dismiss", { key: top.key }); refresh(); }} />
      ) : (
        <button className="card suggest-empty" onClick={onOpenKnows}>
          <Icon name="sparkles" size={20} />
          <span className="grow stack-xs" style={{ textAlign: "left" }}>
            <strong className="subhead">Let your agents learn what you like</strong>
            <span className="footnote muted">Connect your browser or share products to Pocket. You see and control everything it learns.</span>
          </span>
          <Icon name="chevronRight" size={16} className="muted" />
        </button>
      )}
      <button className="link-row" onClick={onSnap}><Icon name="camera" size={18} /><span className="grow">Snap something you want</span><Icon name="chevronRight" size={16} /></button>
    </section>
  );
}

/* ------------------------------------ Snap to want / share ------------------------------------ */

/** Hidden camera input. Call `open()` to take a photo; the result comes back via onResult. */
export function useSnap(onResult: (r: WantResult, photo: string) => void, show: Show) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const el = (
    <input ref={input} type="file" accept="image/*" capture="environment" hidden onChange={async (e) => {
      const f = e.target.files?.[0];
      e.target.value = "";
      if (!f) return;
      setBusy(true);
      show("Looking at your photo…");
      try {
        const photo = await fileToDataUrl(f, 1024);
        const r = await api<WantResult>("/api/snap", { imageDataUrl: photo });
        onResult(r, photo);
      } catch (err) { show((err as Error).message, true); } finally { setBusy(false); }
    }} />
  );
  return { open: () => input.current?.click(), el, busy };
}

/** What Pocket found from a photo or a shared link, and a one-tap agent for it. */
export function WantSheet({ result, photo, onMake }: { result: WantResult; photo?: string; onMake: (p: AgentPrefill) => void }) {
  return (
    <div className="stack">
      <div className="want-hero">
        {photo ? <img src={photo} alt="Your photo" /> : result.matches[0]?.imageUrl ? <img src={result.matches[0].imageUrl} alt="" /> : <span className="look-ph"><Icon name="link" size={28} /></span>}
        <span className="stack-xs grow">
          <span className="caption muted">{result.source === "photo" ? "Looks like" : "From your link"}</span>
          <strong className="title-2">{cap(result.brand && !result.item.toLowerCase().includes(result.brand.toLowerCase()) ? `${result.brand} ${result.item}` : result.item)}</strong>
          {result.description && <span className="footnote muted">{result.description}</span>}
        </span>
      </div>
      {result.matches.length > 0 ? (
        <>
          <h3 className="section-title">In real stores now</h3>
          <ul className="found-list">
            {result.matches.map((m, i) => (
              <li key={i} className="found-item ok">
                {m.imageUrl ? <img src={m.imageUrl} alt="" loading="lazy" /> : <div className="found-ph" />}
                <div className="grow stack-xs">
                  <div className="row between" style={{ alignItems: "flex-start", gap: 8 }}><strong className="footnote">{m.title}</strong><strong className="footnote">{money(m.price)}</strong></div>
                  <span className="caption muted">{m.brand ?? ""}{m.domain ? ` · ${m.domain}` : ""}</span>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : <p className="footnote muted">No listings found yet. An agent can keep watching for it.</p>}
      <div className="card summary-card">
        <Icon name="sparkles" size={20} />
        <p className="footnote grow">Suggested job: <strong>{result.instruction}</strong>. Uses what Pocket knows about your size and usual prices{result.refImage ? ", and searches with your photo" : ""}.</p>
      </div>
      <button className="btn primary block" onClick={() => onMake({ instruction: result.instruction, amount: result.amount, description: result.description || undefined, refImage: result.refImage })}>
        <Icon name="plus" size={18} />Make an agent for this
      </button>
      <p className="caption muted">Nothing is bought until you review the rules and approve with your PIN.</p>
    </div>
  );
}

/** /share: Android share sheet → Pocket. Reads the shared link and shows what Pocket found. */
export function SharePage({ onResult, show, done }: { onResult: (r: WantResult) => void; show: Show; done: () => void }) {
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const q = new URLSearchParams(location.search);
    api<WantResult>("/api/share", { url: q.get("url"), title: q.get("title"), text: q.get("text") })
      .then((r) => { onResult(r); show("Saved to what Pocket knows."); })
      .catch((e) => show((e as Error).message, true))
      .finally(done);
  }, [onResult, show, done]);
  return <div className="card empty"><span className="spinner" /><p className="subhead muted">Reading what you shared…</p></div>;
}

/* ------------------------------------ While writing a rule ------------------------------------ */

/** "Describe it" + reference photo: the agent searches real stores with exactly these details. */
export function DescribeFields({ draft, set }: { draft: MandateDraft; set: (p: Partial<MandateDraft>) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="stack-sm">
      <label className="field">Describe it (optional)
        <textarea className="input textarea short" value={draft.description ?? ""} maxLength={400} placeholder="e.g. white leather low-tops, gum sole, no big logo"
          onChange={(e) => set({ description: e.target.value })} />
      </label>
      <div className="row" style={{ gap: 10 }}>
        {draft.refImage && <img className="ref-thumb" src={`/api/intel/image/${draft.refImage}`} alt="Reference photo" />}
        <button type="button" className="btn sm tonal" disabled={busy} onClick={() => input.current?.click()}>
          <Icon name="camera" size={16} />{busy ? "Adding…" : draft.refImage ? "Change photo" : "Add a photo of it"}
        </button>
        {draft.refImage && <button type="button" className="btn sm ghost" onClick={() => set({ refImage: undefined })}>Remove</button>}
        <input ref={input} type="file" accept="image/*" hidden onChange={async (e) => {
          const f = e.target.files?.[0]; e.target.value = "";
          if (!f) return;
          setBusy(true);
          try { const { hash } = await api<{ hash: string }>("/api/intel/image", { dataUrl: await fileToDataUrl(f, 1024) }); set({ refImage: hash }); } finally { setBusy(false); }
        }} />
      </div>
      <p className="caption muted">Your agent searches stores with these words{draft.refImage ? " and this photo" : ""}, and ranks what matches best. Your rules still decide what it may buy.</p>
    </div>
  );
}

/** Tips from what Pocket knows: "Add size 10 (from your purchases)". One tap applies. */
export function RuleTips({ draft, apply }: { draft: MandateDraft; apply: (p: Partial<MandateDraft>) => void }) {
  const [tips, setTips] = useState<RuleTip[]>([]);
  const key = JSON.stringify([draft.item, draft.required, draft.allowed, draft.maxUnitPrice, draft.avoid, draft.description]);
  useEffect(() => {
    const t = setTimeout(() => { api<RuleTip[]>("/api/intel/tips", { draft }).then(setTips).catch(() => setTips([])); }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!tips.length) return null;
  return (
    <div className="tips">
      <span className="caption muted row" style={{ gap: 6 }}><Icon name="sparkles" size={14} />From what Pocket knows about you</span>
      {tips.map((t) => (
        <button key={t.id} type="button" className="tip" onClick={() => apply(t.patch)}>
          <span className="grow stack-xs" style={{ textAlign: "left" }}><strong className="footnote">{t.text}</strong><span className="caption muted">{t.why}</span></span>
          <span className="btn sm tonal" aria-hidden="true">Add</span>
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------ What Pocket knows ------------------------------------ */

const SOURCE: Record<Signal["source"], { label: string; icon: IconName }> = {
  extension: { label: "Browser", icon: "link" },
  share: { label: "Shared", icon: "external" },
  search: { label: "Search", icon: "store" },
  snap: { label: "Photo", icon: "camera" },
  app: { label: "You in Pocket", icon: "check" },
};
const KIND: Record<Signal["kind"], string> = { view: "Viewed", search: "Searched", cart: "Added to cart", purchase: "Bought", approve: "Approved", skip: "Skipped", decline: "Declined", dispute: "Reported a problem", photo: "Snapped" };

export function KnowsPage({ back, onUse, onSnap, show }: { back: () => void; onUse: (p: AgentPrefill) => void; onSnap: () => void; show: Show }) {
  const { intel, refresh } = useIntel(4000);
  const [code, setCode] = useState<{ code: string; expiresInSec: number } | null>(null);
  const [push, setPush] = useState<"unsupported" | "denied" | "on" | "off">("off");
  useEffect(() => { pushState().then(setPush); }, []);
  const [checkin, setCheckin] = useState<{ body: string; nextAt: string; lastSentAt?: string } | null>(null);
  useEffect(() => { api<{ body: string; nextAt: string; lastSentAt?: string }>("/api/checkin").then(setCheckin).catch(() => {}); }, [intel?.signals.length]);
  const call = async (path: string, body: unknown, ok?: string) => {
    try { await api(path, body); if (ok) show(ok); } catch (e) { show((e as Error).message, true); } finally { refresh(); }
  };
  if (!intel) return <div className="card empty"><span className="spinner" /></div>;
  const p = intel.profile;

  return (
    <div className="stack knows">
      <div className="agents-top">
        <button className="glass-circle" onClick={back} aria-label="Back"><Icon name="chevronLeft" size={22} /></button>
        <h1 className="agents-title">What Pocket knows</h1>
        <span style={{ width: 44 }} />
      </div>
      <p className="subhead muted">Your agents use this to suggest things. It never changes a rule or spends money on its own. You can pause it or delete any of it.</p>

      <div className="card row between">
        <span className="stack-xs grow">
          <strong className="headline">{intel.paused ? "Learning paused" : "Learning on"}</strong>
          <span className="footnote muted">{p.signalCount} thing{p.signalCount === 1 ? "" : "s"} noticed · shopping pages and searches only</span>
        </span>
        <Switch on={!intel.paused} onChange={() => call("/api/intel/pause", { paused: !intel.paused }, intel.paused ? "Learning resumed." : "Learning paused. Nothing new is recorded.")} label="Learning on" />
      </div>

      <div className="card row between">
        <span className="stack-xs grow">
          <strong className="headline">Notifications</strong>
          <span className="footnote muted">{push === "on" ? "On for this phone." : push === "denied" ? "Blocked in your browser settings." : push === "unsupported" ? "Not available here. On iPhone, add Pocket to your Home Screen." : "One check-in a week, plus anything urgent."}</span>
        </span>
        {push === "on" || push === "off" ? (
          <Switch on={push === "on"} onChange={async () => {
            try { if (push === "on") { await disablePush(); setPush("off"); show("Notifications off."); } else { await enablePush(); setPush("on"); show("Notifications on. A test one is on its way."); } }
            catch (e) { show((e as Error).message, true); setPush(await pushState()); }
          }} label="Notifications" />
        ) : null}
      </div>

      {checkin && (
        <div className="card stack-sm">
          <span className="stack-xs">
            <strong className="headline">Weekly check-in</strong>
            <span className="footnote muted">Few interruptions: only urgent things buzz your phone, like a take-a-look you turned on. Everything else waits in the chat and comes together once a week, {new Date(checkin.nextAt).toLocaleDateString([], { weekday: "long" })}s at {new Date(checkin.nextAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.</span>
          </span>
          <div className="quote"><span className="caption muted">Your check-in right now</span><span className="footnote">{checkin.body}</span></div>
          <span className="row between">
            <span className="caption muted">{checkin.lastSentAt ? `Last sent ${when(checkin.lastSentAt)}` : `Next: ${when(checkin.nextAt)}`}</span>
            {push === "on" && <button className="btn sm tonal" onClick={async () => {
              try { const r = await api<{ sent: number }>("/api/checkin/send", {}); show(r.sent ? "Check-in sent to your phone." : "No phone subscribed yet."); setCheckin(await api("/api/checkin")); }
              catch (e) { show((e as Error).message, true); }
            }}>Send it now</button>}
          </span>
        </div>
      )}

      {intel.suggestions.length > 0 && (
        <section className="stack-sm">
          <h2 className="section-title">Agents you might want</h2>
          {intel.suggestions.map((s) => <SuggestionCard key={s.key} s={s} onUse={onUse} onDismiss={() => call("/api/intel/dismiss", { key: s.key })} />)}
        </section>
      )}

      <section className="stack-sm">
        <h2 className="section-title">About you</h2>
        <div className="card stack-sm">
          <KnowRow icon="rules" label="Usual size" value={p.sizes[0] ? `US ${p.sizes[0].size}` : "Not known yet"} why={p.sizes[0]?.why} />
          <KnowRow icon="check" label="Brands you lean to" value={p.brands.length ? p.brands.map((b) => cap(b.brand)).join(", ") : "Not known yet"} why={p.brands[0] ? `${cap(p.brands[0].brand)}: ${p.brands[0].why}` : undefined} />
          {p.dislikedBrands.length > 0 && <KnowRow icon="close" label="Brands you skip" value={p.dislikedBrands.map((b) => cap(b.brand)).join(", ")} why={p.dislikedBrands[0].why} />}
          {p.priceHabits.map((h) => <KnowRow key={h.category} icon="wallet" label={`Usual price · ${h.category}`} value={`about ${money(h.typical)} (up to ${money(h.max)})`} why={h.why} />)}
          {p.flexibility && <KnowRow icon="swap" label="How far you bend" value={`about ${p.flexibility.overPct}% over a limit`} why={p.flexibility.why} />}
          {p.askHint && <KnowRow icon="hand" label="Asking" value={p.askHint.mode === "money" ? "You approve almost everything" : "You like to check"} why={p.askHint.why} />}
        </div>
      </section>

      {p.interests.length > 0 && (
        <section className="stack-sm">
          <h2 className="section-title">Interests</h2>
          {p.interests.slice(0, 8).map((i) => (
            <div key={i.key} className="interest">
              {i.imageUrl ? <img src={i.imageUrl} alt="" loading="lazy" /> : <span className="look-ph"><Icon name="sparkles" size={18} /></span>}
              <span className="grow stack-xs">
                <strong className="footnote">{i.label}</strong>
                <span className="caption muted">
                  {[i.views && `${i.views} view${i.views === 1 ? "" : "s"}`, i.searches && `${i.searches} search${i.searches === 1 ? "" : "es"}`, i.dwellMin >= 1 && `${i.dwellMin} min`, i.domains.slice(0, 2).join(", "), i.priceMin && money(i.priceMin)].filter(Boolean).join(" · ")}
                  {i.bought ? " · bought" : ""}
                </span>
              </span>
              <button className="icon-btn" aria-label={`Forget ${i.label}`} onClick={() => call("/api/intel/forget-interest", { key: i.key, words: i.words.slice(0, 2) }, `Forgot ${i.label}.`)}><Icon name="trash" size={16} /></button>
            </div>
          ))}
        </section>
      )}

      <section className="stack-sm">
        <h2 className="section-title">Where it learns from</h2>
        <div className="card stack-sm">
          <div className="row between" style={{ alignItems: "flex-start" }}>
            <span className="stack-xs grow">
              <strong className="subhead row" style={{ gap: 6 }}><Icon name="link" size={16} />Your browser (computer)</strong>
              <span className="footnote muted">The Pocket extension for Chrome notices product pages and shopping searches. Never other pages, never incognito.</span>
              {intel.devices.map((d) => (
                <span key={d.id} className="row between caption" style={{ marginTop: 4 }}>
                  <span>{d.label} · paired {when(d.pairedAt)}{d.lastSeenAt ? ` · last seen ${when(d.lastSeenAt)}` : ""}</span>
                  <button className="btn sm ghost" onClick={() => call("/api/intel/unpair", { id: d.id }, "Browser disconnected.")}>Disconnect</button>
                </span>
              ))}
              {code ? (
                <span className="pair-code" aria-live="polite">Enter <strong>{code.code}</strong> in the extension · valid 10 min</span>
              ) : (
                <button className="btn sm tonal" style={{ alignSelf: "flex-start", marginTop: 6 }} onClick={async () => setCode(await api("/api/intel/pair-code", {}))}>Connect a browser</button>
              )}
            </span>
          </div>
          <div className="divider" />
          <span className="stack-xs">
            <strong className="subhead row" style={{ gap: 6 }}><Icon name="external" size={16} />Share from any app (Android)</strong>
            <span className="footnote muted">On a product in any app or browser, tap Share → Pocket. Install Pocket to your Home Screen first.</span>
          </span>
          <div className="divider" />
          <button className="row between" style={{ all: "unset", cursor: "pointer", display: "flex", gap: 8 }} onClick={onSnap}>
            <span className="stack-xs grow">
              <strong className="subhead row" style={{ gap: 6 }}><Icon name="camera" size={16} />A photo</strong>
              <span className="footnote muted">See something you like? Snap it and Pocket finds it in real stores.</span>
            </span>
            <Icon name="chevronRight" size={16} className="muted" />
          </button>
        </div>
      </section>

      {intel.signals.length > 0 && (
        <section className="stack-sm">
          <h2 className="section-title">Recently noticed</h2>
          <div className="card stack-sm">
            {intel.signals.slice(0, 25).map((s) => (
              <div key={s.id} className="signal-row">
                <Icon name={SOURCE[s.source].icon} size={16} className="muted" />
                <span className="grow stack-xs">
                  <span className="footnote">{KIND[s.kind]} {s.kind === "search" ? `“${s.query}”` : s.title}</span>
                  <span className="caption muted">{[SOURCE[s.source].label, s.domain, s.price ? money(s.price) : "", s.dwellMs && s.dwellMs > 30000 ? `${Math.round(s.dwellMs / 60000) || "<1"} min` : "", when(s.at)].filter(Boolean).join(" · ")}</span>
                </span>
                <button className="icon-btn" aria-label="Delete" onClick={() => call("/api/intel/forget", { id: s.id })}><Icon name="close" size={14} /></button>
              </div>
            ))}
          </div>
        </section>
      )}

      <button className="btn danger block" onClick={() => { if (confirm("Delete everything Pocket has learned? Your agents, rules and purchases stay.")) call("/api/intel/forget-all", {}, "Deleted. Pocket starts fresh."); }}>
        <Icon name="trash" size={18} />Delete everything Pocket learned
      </button>
      <p className="caption muted">Purchases, rules and Black Box records are kept separately and aren't affected.</p>
    </div>
  );
}

function KnowRow({ icon, label, value, why }: { icon: IconName; label: string; value: string; why?: string }) {
  return (
    <div className="know-row">
      <Icon name={icon} size={16} className="muted" />
      <span className="grow stack-xs">
        <span className="caption muted">{label}</span>
        <strong className="footnote">{value}</strong>
        {why && <span className="caption muted">Because: {why.charAt(0).toLowerCase() + why.slice(1)}</span>}
      </span>
    </div>
  );
}

export type { IntelView };
