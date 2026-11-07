import { useState } from "react";
import { api, money, type AppState, type AskMode, type MandateDraft, type Pocket } from "../api";
import { Icon } from "./Icon";
import { AGENT_COLORS, AgentOrb } from "./agent";
import { SignButton, type Signature } from "./lock";
import { MandateChips, type Act } from "./purchase";
import { Segmented } from "./ui";

/* ------------------------------------ Rule review (shared) ------------------------------------ */

/** Editable structured rules the AI (or plain parser) read from the user's words. */
export function RuleReview({ draft, setDraft, source }: { draft: MandateDraft; setDraft: (d: MandateDraft) => void; source: string }) {
  const size = draft.required.size_us ?? "";
  const brands = (draft.allowed.brand ?? []).join(", ");
  const set = (patch: Partial<MandateDraft>) => setDraft({ ...draft, ...patch });
  return (
    <div className="stack">
      <div className="row between">
        <span className="headline">Check the rules</span>
        <span className="badge blue"><Icon name={source === "ai" ? "sparkles" : "rules"} size={13} />{source === "ai" ? "Read by AI" : "Read by rules"}</span>
      </div>
      <label className="field">Job<input className="input" value={draft.item} onChange={(e) => set({ item: e.target.value })} /></label>
      <div className="row" style={{ gap: 12 }}>
        <label className="field grow">US size<input className="input" value={size} placeholder="any" onChange={(e) => {
          const required = { ...draft.required };
          if (e.target.value.trim()) required.size_us = e.target.value; else delete required.size_us;
          set({ required });
        }} /></label>
        <label className="field grow">Max price ($)<input className="input" inputMode="decimal" value={draft.maxUnitPrice} onChange={(e) => set({ maxUnitPrice: Number(e.target.value.replace(/[^0-9.]/g, "")) })} /></label>
      </div>
      <div className="row" style={{ gap: 12 }}>
        <label className="field grow">Brands<input className="input" value={brands} placeholder="any" onChange={(e) => {
          const list = e.target.value.split(",").map((b) => b.trim().toLowerCase()).filter(Boolean);
          const allowed = { ...draft.allowed };
          if (list.length) allowed.brand = list; else delete allowed.brand;
          set({ allowed });
        }} /></label>
        <label className="field" style={{ width: 96 }}>Max qty<input className="input" inputMode="numeric" value={draft.maxQuantity} onChange={(e) => set({ maxQuantity: Number(e.target.value.replace(/\D/g, "")) || 1 })} /></label>
      </div>
      <label className="field">Never buy (optional)<input className="input" value={(draft.avoid ?? []).join(", ")} placeholder="e.g. paprika" onChange={(e) => set({ avoid: e.target.value.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean) })} /></label>
      <label className="field">Expires<input className="input" type="date" value={draft.expiresAt.slice(0, 10)} onChange={(e) => e.target.value && set({ expiresAt: new Date(`${e.target.value}T23:59:59Z`).toISOString() })} /></label>
      <MandateChips m={draft} />
      <p className="footnote muted">Plain code enforces these at checkout, not the AI.</p>
    </div>
  );
}

function useDraft() {
  const [draft, setDraft] = useState<MandateDraft | null>(null);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const read = async (instruction: string) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ draft: MandateDraft; source: string }>("/api/mandates/draft", { instruction });
      setDraft(r.draft);
      setSource(r.source);
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { draft, setDraft, source, busy, err, read };
}

const EXAMPLES = [
  "Running shoes, size 10, under $100, Nike or Adidas only, expires Nov 30",
  "Concert tickets under $80 each, max 2, until Dec 15",
  "Coffee beans under $25 a bag, max 2 bags",
];

/* ------------------------------------ New agent ------------------------------------ */

/** 1 name + colour → 2 money → 3 job in your words → 4 check the rules, choose when it asks, hold to sign. */
export function NewAgent({ state, act, close, open }: { state: AppState; act: Act; close: () => void; open: (id: string) => void }) {
  const used = new Set(state.pockets.map((p) => p.color));
  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [color, setColor] = useState(AGENT_COLORS.find((c) => !used.has(c)) ?? AGENT_COLORS[0]);
  const [amount, setAmount] = useState("150");
  const [instruction, setInstruction] = useState(EXAMPLES[0]);
  const [askMode, setAskMode] = useState<AskMode>("money");
  const d = useDraft();
  const taken = state.pockets.some((p) => p.name.toLowerCase() === name.trim().toLowerCase());
  const shown = name.trim() || "Your agent";

  const create = (auth: Signature) => act(async () => {
    const r = await api<{ agent: Pocket }>("/api/agents", { auth, name: name.trim(), color, amount: Number(amount), askMode, instruction, draft: d.draft });
    close();
    open(r.agent.id);
  }, `${name.trim()} is ready`);

  return (
    <div className="stack">
      <div className="new-agent-hero">
        <AgentOrb name={shown} color={color} size={72} />
        <div className="stack-xs" style={{ alignItems: "center" }}>
          <strong className="title-2">{shown}</strong>
          <span className="caption muted">Step {step} of 4</span>
        </div>
      </div>

      {step === 1 && (
        <>
          <label className="field">Name your agent
            <input className="input" autoFocus value={name} maxLength={24} placeholder="e.g. P, Sneaks, Groceries" onChange={(e) => setName(e.target.value)} />
          </label>
          {taken && <p className="footnote danger-text">You already have an agent called {name.trim()}.</p>}
          <div className="stack-sm">
            <span className="field-label">Pick its colour</span>
            <div className="swatches" role="radiogroup" aria-label="Agent colour">
              {AGENT_COLORS.map((c) => (
                <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c} className={`swatch ${color === c ? "on" : ""}`} style={{ "--orb": c } as React.CSSProperties} onClick={() => setColor(c)} />
              ))}
            </div>
          </div>
          <button className="btn primary block" disabled={!name.trim() || taken} onClick={() => setStep(2)}>Next</button>
        </>
      )}

      {step === 2 && (
        <>
          <p className="subhead muted">How much can {shown} spend? It can never touch anything outside this.</p>
          <div className="amount-input"><span>$</span><input className="input big" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} aria-label="Amount in US dollars" /></div>
          <div className="chips">
            {[50, 100, 150, 300].map((v) => <button key={v} className={`chip btnlike ${Number(amount) === v ? "on" : ""}`} onClick={() => setAmount(String(v))}>${v}</button>)}
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn ghost" onClick={() => setStep(1)}>Back</button>
            <button className="btn primary grow" disabled={!(Number(amount) > 0)} onClick={() => setStep(3)}>Next</button>
          </div>
        </>
      )}

      {step === 3 && (
        <>
          <p className="subhead muted">What is {shown}'s one job? Say it in your own words, with your limits.</p>
          <textarea className="input textarea" value={instruction} onChange={(e) => setInstruction(e.target.value)} aria-label="The job in your words" />
          <div className="chips">{EXAMPLES.slice(1).map((x) => <button key={x} className="chip btnlike" onClick={() => setInstruction(x)}>{x.split(",")[0]}</button>)}</div>
          {d.err && <p className="footnote danger-text">{d.err}</p>}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn ghost" onClick={() => setStep(2)}>Back</button>
            <button className="btn primary grow" disabled={d.busy || !instruction.trim()} onClick={async () => { if (await d.read(instruction)) setStep(4); }}>
              {d.busy ? <><span className="spinner" />Reading your words…</> : "Turn into rules"}
            </button>
          </div>
        </>
      )}

      {step === 4 && d.draft && (
        <>
          <RuleReview draft={d.draft} setDraft={d.setDraft} source={d.source} />
          <div className="stack-sm">
            <span className="headline">When should {shown} ask you?</span>
            <Segmented<AskMode> value={askMode} onChange={setAskMode} options={[{ value: "anything", label: "About anything" }, { value: "money", label: "Only about money" }]} />
            <p className="footnote muted">{askMode === "anything" ? "Every purchase waits for your tap." : "Buys on its own inside the rules; asks when money or a limit is involved."}</p>
          </div>
          <div className="card summary-card" style={{ "--orb": color } as React.CSSProperties}>
            <AgentOrb name={shown} color={color} size={36} />
            <p className="footnote grow"><strong>{shown}</strong> gets <strong>{money(Number(amount))}</strong> for one job: <span className="capitalize">{d.draft.item}</span>. Out of bounds, it stops and asks you.</p>
          </div>
          <SignButton title={`Create ${shown}`} detail={`${money(Number(amount))} for one job: ${d.draft.item}`} onSigned={create} disabled={!(d.draft.maxUnitPrice > 0) || !d.draft.item.trim()}>Create &amp; sign</SignButton>
          <button className="btn ghost block" onClick={() => setStep(3)}>Back</button>
        </>
      )}
    </div>
  );
}

/* ------------------------------------ Job (give or rewrite) ------------------------------------ */

export function JobSheet({ state, agentId, act, close }: { state: AppState; agentId: string; act: Act; close: () => void }) {
  const agent = state.pockets.find((p) => p.id === agentId);
  const current = state.mandates.find((m) => m.mandate.pocketId === agentId)?.mandate;
  const [instruction, setInstruction] = useState(current?.instruction.replace(/\s*\((?:changed|exception|clarified)[^)]*\)\s*$/, "") ?? EXAMPLES[0]);
  const d = useDraft();
  if (!agent) return null;
  return (
    <div className="stack">
      <div className="row" style={{ gap: 12 }}>
        <AgentOrb name={agent.name} color={agent.color} size={40} />
        <h2 className="title-2">{current ? `Rewrite ${agent.name}'s job` : `Give ${agent.name} a job`}</h2>
      </div>
      {!d.draft ? (
        <>
          <p className="subhead muted">One agent, one job. {current ? "The old rules retire and stay on record." : ""}</p>
          <textarea className="input textarea" value={instruction} onChange={(e) => setInstruction(e.target.value)} aria-label="The job in your words" />
          {d.err && <p className="footnote danger-text">{d.err}</p>}
          <button className="btn primary block" disabled={d.busy || !instruction.trim()} onClick={() => d.read(instruction)}>
            {d.busy ? <><span className="spinner" />Reading your words…</> : "Turn into rules"}
          </button>
        </>
      ) : (
        <>
          <RuleReview draft={d.draft} setDraft={d.setDraft} source={d.source} />
          <SignButton title={`Sign ${agent.name}'s job`} detail={d.draft.item} onSigned={(auth) => act(() => api(`/api/agents/${agentId}/job`, { auth, instruction, draft: d.draft }), "New job signed").then(close)}>Sign the job</SignButton>
          <button className="btn ghost block" onClick={() => d.setDraft(null)}>Back</button>
        </>
      )}
    </div>
  );
}

/* ------------------------------------ Move money between agents ------------------------------------ */

export function MoveMoney({ state, agentId, act, close }: { state: AppState; agentId: string; act: Act; close: () => void }) {
  const to = state.pockets.find((p) => p.id === agentId);
  const sources = state.pockets.filter((p) => p.id !== agentId);
  const [fromId, setFromId] = useState(sources.slice().sort((a, b) => b.balance - a.balance)[0]?.id ?? "");
  const [amount, setAmount] = useState("20");
  const from = sources.find((p) => p.id === fromId);
  if (!to) return null;
  const amt = Number(amount);
  const ok = from && amt > 0 && amt <= from.balance;
  return (
    <div className="stack">
      <h2 className="title-2">Move money to {to.name}</h2>
      {sources.length === 0 ? (
        <p className="subhead muted">You only have one agent. Create another to move money between them.</p>
      ) : (
        <>
          <div className="stack-sm">
            <span className="field-label">From</span>
            <div className="agent-picker">
              {sources.map((p) => (
                <button key={p.id} className={`agent-pick ${fromId === p.id ? "on" : ""}`} style={{ "--orb": p.color } as React.CSSProperties} onClick={() => setFromId(p.id)}>
                  <AgentOrb name={p.name} color={p.color} size={32} />
                  <span className="stack-xs"><strong className="footnote">{p.name}</strong><span className="caption muted">{money(p.balance)}</span></span>
                </button>
              ))}
            </div>
          </div>
          <label className="field">Amount
            <div className="amount-input"><span>$</span><input className="input big" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} /></div>
          </label>
          {from && (
            <div className="diff card">
              <div className="diff-row"><span className="muted footnote">{from.name}</span><span className="diff-vals"><s className="muted">{money(from.balance)}</s><Icon name="chevronRight" size={14} /><strong>{money(Math.max(0, from.balance - (amt || 0)))}</strong></span></div>
              <div className="diff-row"><span className="muted footnote">{to.name}</span><span className="diff-vals"><s className="muted">{money(to.balance)}</s><Icon name="chevronRight" size={14} /><strong>{money(to.balance + (ok ? amt : 0))}</strong></span></div>
            </div>
          )}
          {from && amt > from.balance && <p className="footnote danger-text">{from.name} only has {money(from.balance)}.</p>}
          <SignButton disabled={!ok} title={`Move ${money(amt || 0)}`} detail={`From ${from?.name ?? ""} to ${to.name}`} onSigned={(auth) => act(() => api(`/api/agents/${agentId}/transfer`, { auth, fromId, amount: amt }), `Moved ${money(amt)} to ${to.name}`).then(close)}>Sign to move {ok ? money(amt) : ""}</SignButton>
        </>
      )}
    </div>
  );
}
