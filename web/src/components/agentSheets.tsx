import { useState } from "react";
import { api, money, useIntel, type AgentKind, type AgentPrefill, type AppState, type AskMode, type MandateDraft, type Pocket } from "../api";
import { DescribeFields, RuleTips, SuggestionCard } from "./intel";
import { ListEditor, useCatalog, type ListRow } from "./orders";
import { Icon } from "./Icon";
import { AGENT_COLORS, AgentIcon, PALETTE, activeMandate, agentTone, limitsLine, suggestPocketName, toneOf } from "./agent";
import { SignButton, useSigner, type Signature } from "./lock";
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
      <DescribeFields draft={draft} set={set} />
      <RuleTips draft={draft} apply={set} />
      <MandateChips m={draft} />
      <p className="footnote muted">These rules are checked at checkout, before anything is paid.</p>
    </div>
  );
}

function useDraft() {
  const [draft, setDraft] = useState<MandateDraft | null>(null);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const read = async (instruction: string, keep?: Pick<MandateDraft, "description" | "refImage">) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ draft: MandateDraft; source: string }>("/api/mandates/draft", { instruction });
      setDraft({ ...r.draft, ...(keep?.description ? { description: keep.description } : {}), ...(keep?.refImage ? { refImage: keep.refImage } : {}) });
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

/** Focus a field once the bottom sheet has finished sliding up, so the phone keyboard doesn't jolt the animation. */
const focusAfterSheet = (el: HTMLInputElement | null) => {
  if (!el) return;
  setTimeout(() => el.focus({ preventScroll: true }), 420);
};

/** 1 money → 2 job in your words → 3 check the rules, name (suggested from the job), when it asks, approve. */
export function NewAgent({ state, act, close, open, prefill }: { state: AppState; act: Act; close: () => void; open: (id: string) => void; prefill?: AgentPrefill }) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState<string | null>(null); // null = use the suggestion
  const color = AGENT_COLORS[0]; // stored for older clients; the UI doesn't colour-code agents
  const [amount, setAmount] = useState(String(prefill?.amount ?? 150));
  const [instruction, setInstruction] = useState(prefill?.instruction ?? EXAMPLES[0]);
  const [keep, setKeep] = useState<Pick<MandateDraft, "description" | "refImage">>({ description: prefill?.description, refImage: prefill?.refImage });
  const { intel, refresh: refreshIntel } = useIntel(30000);
  const ideas = (intel?.suggestions ?? []).slice(0, 2);
  const [askMode, setAskMode] = useState<AskMode>("money");
  const d = useDraft();
  // Three kinds of agent: a one-time hunt (default), a weekly routine shop, or a right-now order.
  const [kind, setKind] = useState<AgentKind>("hunt");
  const catalog = useCatalog();
  const [rows, setRows] = useState<ListRow[] | null>(null);
  const list = rows ?? (catalog ? catalog.starter.map((x) => ({ productId: x.productId, qty: x.qty, usualPrice: catalog.groups.flatMap((g) => g.products).find((p) => p.id === x.productId)?.price ?? 0 })) : []);
  const usualWeek = Math.round(list.reduce((t, r) => t + r.usualPrice * r.qty, 0) * 100) / 100;
  const [budget, setBudget] = useState<string | null>(null);
  const weeklyBudget = budget ?? String(Math.ceil(usualWeek * 1.15));
  const routine = kind === "routine";
  const chooseKind = (k: AgentKind) => {
    setKind(k);
    if (k === "now") setInstruction("Chicken biryani under $15 with delivery, within 30 minutes");
    else if (k === "hunt" && /biryani/i.test(instruction)) setInstruction(EXAMPLES[0]);
  };
  const suggested = suggestPocketName(routine ? "weekly groceries" : d.draft?.item, state.pockets.map((p) => p.name));
  const finalName = (name ?? suggested).trim();
  const taken = state.pockets.some((p) => p.name.toLowerCase() === finalName.toLowerCase());
  const shown = step === 3 ? finalName || "New pocket" : "New pocket";

  const create = (auth: Signature) => act(async () => {
    const body = routine
      ? { auth, kind: "routine", name: finalName, color, amount: Number(amount), askMode, list, weeklyBudget: Number(weeklyBudget) }
      : { auth, name: finalName, color, amount: Number(amount), askMode, instruction, draft: kind === "now" ? { ...d.draft, kind: "now" } : d.draft };
    const r = await api<{ agent: Pocket }>("/api/agents", body);
    close();
    open(r.agent.id);
  }, undefined, { rethrow: true });

  return (
    <div className="stack">
      <div className="new-agent-hero">
        <AgentIcon name={step === 3 ? shown : undefined} item={routine && step >= 2 ? "weekly groceries" : d.draft?.item ?? (step >= 2 ? instruction : undefined)} tone={agentTone(routine && step >= 2 ? "weekly groceries" : d.draft?.item ?? (step >= 2 ? instruction : undefined))} size={64} />
        <div className="stack-xs" style={{ alignItems: "center" }}>
          <strong className="title-2">{shown}</strong>
          <span className="caption muted">Step {step} of 3</span>
        </div>
      </div>

      {step === 1 && (
        <>
          {prefill?.why && <p className="footnote muted row" style={{ gap: 6 }}><Icon name="sparkles" size={14} />Suggested because: {prefill.why.charAt(0).toLowerCase() + prefill.why.slice(1)}</p>}
          <p className="subhead muted">How much can this agent spend? It can't spend more than this.</p>
          <div className="amount-input"><span>$</span><input className="input big" ref={focusAfterSheet} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} aria-label="Amount in US dollars" /></div>
          <div className="chips">
            {[50, 100, 150, 300].map((v) => <button key={v} className={`chip btnlike ${Number(amount) === v ? "on" : ""}`} onClick={() => setAmount(String(v))}>${v}</button>)}
          </div>
          <button className="btn primary block" disabled={!(Number(amount) > 0)} onClick={() => setStep(2)}>Next</button>
        </>
      )}

      {step === 2 && (
        <Segmented<AgentKind> value={kind} onChange={chooseKind} options={[{ value: "hunt", label: "One-time hunt" }, { value: "routine", label: "Weekly shop" }, { value: "now", label: "Right now" }]} />
      )}
      {step === 2 && routine && (
        <>
          <p className="subhead muted">Your weekly list. The agent reorders it every week, buys each item where it's cheapest, and asks once about better deals.</p>
          {catalog ? <ListEditor rows={list} setRows={setRows} groups={catalog.groups} /> : <span className="spinner" />}
          <label className="field">Weekly budget ($)
            <input className="input" inputMode="decimal" value={weeklyBudget} onChange={(e) => setBudget(e.target.value.replace(/[^0-9.]/g, ""))} />
          </label>
          <p className="caption muted">Stores are simulated (FreshCart, DailyMart). Real grocery apps don't offer ordering APIs yet.</p>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn ghost" onClick={() => setStep(1)}>Back</button>
            <button className="btn primary grow" disabled={!list.length || !(Number(weeklyBudget) > 0)} onClick={() => setStep(3)}>Next</button>
          </div>
        </>
      )}
      {step === 2 && !routine && (
        <>
          <p className="subhead muted">{kind === "now" ? "What do you want right now? Say the budget and how fast it must arrive." : "What should it buy? Describe it in your own words, with your limits."}</p>
          <textarea className="input textarea" value={instruction} onChange={(e) => setInstruction(e.target.value)} aria-label="The job in your words" />
          {keep.refImage && <p className="footnote muted row" style={{ gap: 8 }}><img className="ref-thumb" src={`/api/intel/image/${keep.refImage}`} alt="" />Your photo will be used to search too.</p>}
          {!prefill && ideas.length > 0 ? (
            <div className="stack-sm">
              <span className="caption muted row" style={{ gap: 6 }}><Icon name="sparkles" size={14} />Based on what you've been looking at</span>
              {ideas.map((s) => (
                <SuggestionCard key={s.key} s={s} compact
                  onUse={(p) => { setInstruction(p.instruction); if (p.amount) setAmount(String(p.amount)); setKeep({}); }}
                  onDismiss={async () => { await api("/api/intel/dismiss", { key: s.key }); refreshIntel(); }} />
              ))}
            </div>
          ) : (
            <div className="chips">{EXAMPLES.slice(1).map((x) => <button key={x} className="chip btnlike" onClick={() => setInstruction(x)}>{x.split(",")[0]}</button>)}</div>
          )}
          {d.err && <p className="footnote danger-text">{d.err}</p>}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn ghost" onClick={() => setStep(1)}>Back</button>
            <button className="btn primary grow" disabled={d.busy || !instruction.trim()} onClick={async () => { if (await d.read(instruction, keep)) setStep(3); }}>
              {d.busy ? <><span className="spinner" />Creating rules…</> : "Create rules"}
            </button>
          </div>
        </>
      )}

      {step === 3 && routine && (
        <>
          <label className="field">Name
            <input className="input" value={name ?? suggested} maxLength={24} onChange={(e) => setName(e.target.value)} />
          </label>
          {taken && <p className="footnote danger-text">You already have an agent called {finalName}.</p>}
          <div className="stack-sm">
            <span className="headline">When should {shown} ask you?</span>
            <Segmented<AskMode> value={askMode} onChange={setAskMode} options={[{ value: "anything", label: "About anything" }, { value: "money", label: "Only about money" }]} />
            <p className="footnote muted">{askMode === "anything" ? "Each week's order waits for your approval." : "Places each week's order on its own. Swaps and anything that costs more always ask you first."}</p>
          </div>
          <div className="card summary-card">
            <AgentIcon name={shown} item="weekly groceries" tone={agentTone("weekly groceries")} size={36} />
            <p className="footnote grow"><strong>{shown}</strong> gets <strong>{money(Number(amount))}</strong> for your weekly shop: <strong>{list.length} items</strong>, usually about {money(usualWeek)}, never more than {money(Number(weeklyBudget))} a week.</p>
          </div>
          <SignButton progress={{ working: `Setting up ${finalName}`, done: `${finalName} is ready` }} title={`Create ${shown}`} detail={`Weekly shop · ${list.length} items · up to ${money(Number(weeklyBudget))} a week`}
            approval={{ amount: Number(amount), rows: [{ label: "Agent", value: shown }, { label: "Job", value: `Weekly shop, ${list.length} items` }, { label: "Weekly budget", value: money(Number(weeklyBudget)) }, { label: "Swaps", value: "Always ask, this week only" }], note: "This amount moves into the agent's pocket. It can't spend more than this." }}
            onSigned={create} disabled={!finalName || taken || !list.length}>Create agent</SignButton>
          <button className="btn ghost block" onClick={() => setStep(2)}>Back</button>
        </>
      )}

      {step === 3 && !routine && d.draft && (
        <>
          <label className="field">Name
            <input className="input" value={name ?? suggested} maxLength={24} onChange={(e) => setName(e.target.value)} aria-describedby="name-hint" />
          </label>
          <p id="name-hint" className={`footnote ${taken ? "danger-text" : "muted"}`}>{taken ? `You already have an agent called ${finalName}.` : "Suggested from its job. You can change it any time."}</p>
          <RuleReview draft={d.draft} setDraft={d.setDraft} source={d.source} />
          <div className="stack-sm">
            <span className="headline">When should {shown} ask you?</span>
            <Segmented<AskMode> value={askMode} onChange={setAskMode} options={[{ value: "anything", label: "About anything" }, { value: "money", label: "Only about money" }]} />
            <p className="footnote muted">{askMode === "anything" ? "Every purchase waits for your approval." : "Buys on its own within the rules. Asks you when a limit is involved."}</p>
          </div>
          <div className="card summary-card">
            <AgentIcon name={shown} item={d.draft.item} tone={agentTone(d.draft.item)} size={36} />
            <p className="footnote grow"><strong>{shown}</strong> gets <strong>{money(Number(amount))}</strong> to buy <span className="capitalize">{d.draft.item}</span>. If something doesn't fit your rules, it asks you first.</p>
          </div>
          <SignButton progress={{ working: `Setting up ${finalName}`, done: `${finalName} is ready` }} title={`Create ${shown}`} detail={`${money(Number(amount))} for one job: ${d.draft.item}`} approval={{ amount: Number(amount), rows: [{ label: "Agent", value: shown }, { label: "Job", value: d.draft.item }, { label: "Limits", value: limitsLine(d.draft) }, { label: "Asks you", value: askMode === "anything" ? "Before every purchase" : "When a limit is involved" }], note: "This amount moves into the agent's pocket. It can't spend more than this." }} onSigned={create} disabled={!finalName || taken || !(d.draft.maxUnitPrice > 0) || !d.draft.item.trim()}>Create agent</SignButton>
          <button className="btn ghost block" onClick={() => setStep(2)}>Back</button>
        </>
      )}
    </div>
  );
}

/* ------------------------------------ Edit (name and colour) ------------------------------------ */

/** Edit an agent's name and colour. No PIN: neither moves money. Undo is offered from the toast. */
export function RenameAgent({ state, agentId, close, show, refresh }: {
  state: AppState; agentId: string; close: () => void;
  show: (t: string, e?: boolean, action?: { label: string; run: () => void }) => void; refresh: () => Promise<void> | void;
}) {
  const agent = state.pockets.find((p) => p.id === agentId);
  const item = activeMandate(state, agentId)?.mandate.item;
  const startTone = toneOf(agent, item);
  const [name, setName] = useState(agent?.name ?? "");
  const [tone, setTone] = useState(startTone);
  const [busy, setBusy] = useState(false);
  if (!agent) return null;
  const clean = name.trim();
  const taken = state.pockets.some((p) => p.id !== agent.id && p.name.toLowerCase() === clean.toLowerCase());
  const suggestion = suggestPocketName(item, state.pockets.filter((p) => p.id !== agent.id).map((p) => p.name));
  const hexOf = (t: string) => PALETTE.find((c) => c.id === t)!.hex;
  const changed = clean !== agent.name || tone !== startTone;
  const save = async (patch: { name?: string; color?: string }, undo?: { name?: string; color?: string }) => {
    setBusy(true);
    try {
      await api(`/api/agents/${agentId}/settings`, patch);
      show(patch.name && patch.name !== agent.name ? `Renamed to ${patch.name}.` : "Saved.", false, undo ? { label: "Undo", run: () => save(undo) } : undefined);
      close();
    } catch (e) {
      show((e as Error).message, true);
    } finally {
      setBusy(false);
      refresh();
    }
  };
  const submit = () => {
    const patch: { name?: string; color?: string } = {};
    const undo: { name?: string; color?: string } = {};
    if (clean !== agent.name) { patch.name = clean; undo.name = agent.name; }
    if (tone !== startTone) { patch.color = hexOf(tone); undo.color = agent.color ?? AGENT_COLORS[0]; }
    save(patch, undo);
  };
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); if (clean && !taken && changed) submit(); }}>
      <div className="row" style={{ gap: 12 }}>
        <AgentIcon name={clean || agent.name} item={item} tone={tone} size={48} />
        <h2 className="title-2">Edit agent</h2>
      </div>
      <label className="field">Name
        <input className="input" value={name} maxLength={24} onChange={(e) => setName(e.target.value)} aria-describedby="rename-hint" />
      </label>
      <p id="rename-hint" className={`footnote ${taken ? "danger-text" : "muted"}`}>{taken ? `You already have an agent called ${clean}.` : "Up to 24 characters. Past messages keep the old name."}</p>
      {suggestion.toLowerCase() !== clean.toLowerCase() && (
        <div className="chips"><button type="button" className="chip btnlike" onClick={() => setName(suggestion)}>Use “{suggestion}”</button></div>
      )}
      <fieldset className="swatch-field">
        <legend className="field-label">Colour</legend>
        <div className="swatch-row" role="radiogroup" aria-label="Agent colour">
          {PALETTE.map((c) => (
            <button key={c.id} type="button" role="radio" aria-checked={tone === c.id} aria-label={c.label}
              className={`swatch-btn tone-${c.id} ${tone === c.id ? "on" : ""}`} onClick={() => setTone(c.id)}>
              <span className="swatch-dot">{tone === c.id && <Icon name="check" size={18} stroke={3} />}</span>
              <span className="swatch-name">{c.label}</span>
            </button>
          ))}
        </div>
        <p className="caption muted">Shows on its card, in the pile on Home and on its page.</p>
      </fieldset>
      <button className="btn primary block" type="submit" disabled={busy || !clean || taken || !changed}>{busy ? <span className="spinner" /> : "Save"}</button>
    </form>
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
        <AgentIcon name={agent.name} item={current?.item} tone={toneOf(agent, current?.item)} size={40} />
        <h2 className="title-2">{current ? `Rewrite ${agent.name}'s job` : `Give ${agent.name} a job`}</h2>
      </div>
      {!d.draft ? (
        <>
          <p className="subhead muted">Each agent has one job. {current ? "Your current rules are kept in history." : ""}</p>
          <textarea className="input textarea" value={instruction} onChange={(e) => setInstruction(e.target.value)} aria-label="The job in your words" />
          {d.err && <p className="footnote danger-text">{d.err}</p>}
          <button className="btn primary block" disabled={d.busy || !instruction.trim()} onClick={() => d.read(instruction)}>
            {d.busy ? <><span className="spinner" />Creating rules…</> : "Create rules"}
          </button>
        </>
      ) : (
        <>
          <RuleReview draft={d.draft} setDraft={d.setDraft} source={d.source} />
          <SignButton progress={{ working: `Approving ${agent.name}'s job`, done: "Job approved" }} title={`New job for ${agent.name}`} detail={d.draft.item} approval={{ rows: [{ label: "Agent", value: agent.name }, { label: "Job", value: d.draft.item }, { label: "Limits", value: limitsLine(d.draft) }, ...(current ? [{ label: "Replaces", value: current.item }] : [])] }} onSigned={(auth) => act(() => api(`/api/agents/${agentId}/job`, { auth, instruction, draft: d.draft }), undefined, { rethrow: true }).then(close)}>Approve job</SignButton>
          <button className="btn ghost block" onClick={() => d.setDraft(null)}>Back</button>
        </>
      )}
    </div>
  );
}

/* ------------------------------------ Move money between agents ------------------------------------ */

export function MoveMoney({ state, agentId, act, close }: { state: AppState; agentId: string; act: Act; close: () => void }) {
  const to = state.pockets.find((p) => p.id === agentId);
  const sources = state.pockets.filter((p) => p.id !== agentId && !p.closedAt);
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
                <button key={p.id} className={`agent-pick ${fromId === p.id ? "on" : ""}`} aria-pressed={fromId === p.id} onClick={() => setFromId(p.id)}>
                  <AgentIcon name={p.name} item={activeMandate(state, p.id)?.mandate.item} tone={toneOf(p, activeMandate(state, p.id)?.mandate.item)} size={32} />
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
          <SignButton disabled={!ok} progress={{ working: `Moving ${money(amt || 0)}`, done: `${money(amt || 0)} moved to ${to.name}` }} title="Move money" detail={`From ${from?.name ?? ""} to ${to.name}`} approval={{ amount: amt || 0, rows: [{ label: "From", value: `${from?.name ?? ""} · ${money(Math.max(0, (from?.balance ?? 0) - (amt || 0)))} after` }, { label: "To", value: `${to.name} · ${money(to.balance + (amt || 0))} after` }] }} onSigned={(auth) => act(() => api(`/api/agents/${agentId}/transfer`, { auth, fromId, amount: amt }), undefined, { rethrow: true }).then(close)}>Review and move {ok ? money(amt) : ""}</SignButton>
        </>
      )}
    </div>
  );
}

/* ------------------------------------ Agent menu, close, delete ------------------------------------ */

type Show = (t: string, e?: boolean, action?: { label: string; run: () => void }) => void;
type SheetTo = (s: { kind: "move" | "rename" | "close" | "delete"; id: string } | null) => void;

/** The "⋯" menu: every action for one agent, in one place. Same actions as the agent page. */
export function AgentMenu({ state, agentId, setSheet, show, refresh }: { state: AppState; agentId: string; setSheet: SheetTo; show: Show; refresh: () => Promise<void> | void }) {
  const a = state.pockets.find((p) => p.id === agentId);
  if (!a) return null;
  const hasPurchases = state.purchases.some((p) => p.pocketId === a.id);
  const setPaused = async (paused: boolean) => {
    setSheet(null);
    try {
      await api(`/api/agents/${a.id}/settings`, { paused });
      show(paused ? `${a.name} paused. Nothing will be bought.` : `${a.name} resumed.`, false, { label: "Undo", run: () => { api(`/api/agents/${a.id}/settings`, { paused: !paused }).finally(refresh); } });
    } catch (e) { show((e as Error).message, true); } finally { refresh(); }
  };
  return (
    <div className="stack-sm">
      <div className="row" style={{ gap: 12 }}>
        <AgentIcon name={a.name} item={activeMandate(state, a.id)?.mandate.item} tone={a.closedAt ? "grey" : toneOf(a, activeMandate(state, a.id)?.mandate.item)} size={40} paused={a.paused || !!a.closedAt} />
        <span className="stack-xs grow">
          <h2 className="title-2 ellipsis">{a.name}</h2>
          <span className="footnote muted">{a.closedAt ? `Closed ${new Date(a.closedAt).toLocaleDateString([], { month: "short", day: "numeric" })}` : `${money(a.balance)} left`}</span>
        </span>
      </div>
      <div className="menu-list" role="list">
        {!a.closedAt && <button role="listitem" className="menu-row" onClick={() => setSheet({ kind: "move", id: a.id })}><Icon name="swap" size={20} /><span className="grow">Move money to {a.name}</span></button>}
        <button role="listitem" className="menu-row" onClick={() => setSheet({ kind: "rename", id: a.id })}><Icon name="pencil" size={20} /><span className="grow">Edit name and colour</span></button>
        {!a.closedAt && <button role="listitem" className="menu-row" onClick={() => setPaused(!a.paused)}><Icon name={a.paused ? "play" : "pause"} size={20} /><span className="grow">{a.paused ? "Resume" : "Pause"}</span></button>}
        {!a.closedAt && <button role="listitem" className="menu-row" onClick={() => setSheet({ kind: "close", id: a.id })}><Icon name="archive" size={20} /><span className="grow">Close agent</span></button>}
        {a.closedAt && <RestoreButton state={state} agentId={a.id} after={() => setSheet(null)} />}
        {!hasPurchases && <button role="listitem" className="menu-row destructive" onClick={() => setSheet({ kind: "delete", id: a.id })}><Icon name="trash" size={20} /><span className="grow">Delete agent</span></button>}
      </div>
      {hasPurchases && <p className="caption muted">Agents with purchases can be closed but not deleted. Their records protect you.</p>}
    </div>
  );
}

/** Restoring lets an agent spend again, so it goes through the approval sheet and PIN. */
export function RestoreButton({ state, agentId, after }: { state: AppState; agentId: string; after?: () => void }) {
  const a = state.pockets.find((p) => p.id === agentId);
  if (!a) return null;
  const m = activeMandate(state, a.id)?.mandate;
  return (
    <SignButton
      title={`Restore ${a.name}`}
      approval={{ amount: a.balance, rows: [{ label: "Agent", value: a.name }, { label: "Job", value: m?.item ?? "No job" }, ...(m ? [{ label: "Limits", value: limitsLine(m) }] : [])], note: "It can buy again within these rules." }}
      progress={{ working: `Restoring ${a.name}`, done: `${a.name} is back` }}
      onSigned={async (auth) => { await api(`/api/agents/${a.id}/restore`, { auth }); after?.(); }}
    >Restore {a.name}</SignButton>
  );
}

/** Close: consequences spelled out, nothing hidden. No PIN (it only stops spending); Undo restores with PIN. */
export function CloseAgent({ state, agentId, close, show, refresh }: { state: AppState; agentId: string; close: () => void; show: Show; refresh: () => Promise<void> | void }) {
  const sign = useSigner();
  const [busy, setBusy] = useState(false);
  const a = state.pockets.find((p) => p.id === agentId);
  if (!a) return null;
  const waiting = state.purchases.filter((p) => p.pocketId === a.id && p.status === "needs_approval").length;
  const proposals = state.proposals.filter((p) => p.agentId === a.id && p.status === "pending").length;
  const disputed = state.purchases.some((p) => p.pocketId === a.id && p.status === "disputed");
  const name = a.name;

  const restore = async () => {
    const sig = await sign({ title: `Restore ${name}`, approval: { amount: a.balance, rows: [{ label: "Agent", value: name }], note: "It can buy again within its rules." } });
    if (!sig) return;
    try { await api(`/api/agents/${a.id}/restore`, { auth: sig }); show(`${name} restored.`); } catch (e) { show((e as Error).message, true); } finally { refresh(); }
  };
  const confirm = async () => {
    setBusy(true);
    const rows = [...document.querySelectorAll<HTMLElement>(".agent-row-main")];
    const at = rows.findIndex((r) => r.dataset.agent === a.id);
    try {
      await api(`/api/agents/${a.id}/close`, {});
      close();
      show(`${name} closed.`, false, { label: "Undo", run: restore });
      await refresh();
      // Keep keyboard and screen-reader users in place: focus the next agent, or New agent.
      setTimeout(() => {
        const next = [...document.querySelectorAll<HTMLElement>(".agent-row-main")];
        (next[Math.min(Math.max(at, 0), next.length - 1)] ?? document.querySelector<HTMLElement>(".new-agent-btn"))?.focus();
      }, 50);
    } catch (e) {
      show((e as Error).message, true);
    } finally { setBusy(false); }
  };

  return (
    <div className="stack">
      <h2 className="title-2">Close {name}?</h2>
      <ul className="consequences">
        <li><Icon name="hand" size={18} /><span>It stops buying right away.</span></li>
        <li><Icon name="wallet" size={18} /><span>Its {money(a.balance)} budget is set aside. No money moves; it was only a limit.</span></li>
        {(waiting > 0 || proposals > 0) && <li><Icon name="close" size={18} /><span>{[waiting ? `${waiting} purchase${waiting === 1 ? "" : "s"} waiting for approval` : "", proposals ? `${proposals} suggested change${proposals === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ")} will be declined.</span></li>}
        <li><Icon name="box" size={18} /><span>Purchases, receipts and Black Box records stay, so you can still get help with past orders.</span></li>
        <li><Icon name="undo" size={18} /><span>You can restore it any time from Closed agents.</span></li>
      </ul>
      {disputed && <p className="footnote warn-text" role="note">A refund is in progress. You can close this agent after it settles.</p>}
      <button className="btn cta block" disabled={busy || disputed} onClick={confirm}>{busy ? <span className="spinner" /> : "Close agent"}</button>
      <button className="btn ghost block" onClick={close}>Cancel</button>
    </div>
  );
}

/** Delete: only for an agent that never bought anything, so nothing is lost. Can't be undone. */
export function DeleteAgent({ state, agentId, close, show, refresh, after }: { state: AppState; agentId: string; close: () => void; show: Show; refresh: () => Promise<void> | void; after?: () => void }) {
  const [busy, setBusy] = useState(false);
  const a = state.pockets.find((p) => p.id === agentId);
  if (!a) return null;
  const go = async () => {
    setBusy(true);
    try { await api(`/api/agents/${a.id}/delete`, {}); close(); after?.(); show(`${a.name} deleted.`); } catch (e) { show((e as Error).message, true); } finally { setBusy(false); refresh(); }
  };
  return (
    <div className="stack">
      <h2 className="title-2">Delete {a.name}?</h2>
      <p className="subhead muted">It never bought anything, so no records are lost. Its chat and job are removed. This can't be undone.</p>
      <button className="btn danger block" disabled={busy} onClick={go}><Icon name="trash" size={18} />{busy ? <span className="spinner" /> : "Delete agent"}</button>
      <button className="btn ghost block" onClick={close}>Cancel</button>
    </div>
  );
}
