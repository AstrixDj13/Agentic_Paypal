import { useState } from "react";
import type { AppState } from "../api";
import { Icon } from "./Icon";
import { useSigner, type Signature } from "./lock";

/**
 * Pause all agents: quiet when everything is fine, unmistakable when it's on.
 *  - At rest: one status line under the balance ("● 4 agents active"). Tap it for the control.
 *  - Pausing is instant (it only makes things safer).
 *  - Resuming gives spending power back, so it asks for your PIN / fingerprint / Face ID.
 *  - While paused: a banner on Home and Agents, and the cards lose their colour.
 */

export type SetKill = (on: boolean, auth?: Signature) => Promise<void>;

/** Resume, behind the same confirmation as any payment. */
export function useResumeAll(setKill: SetKill) {
  const sign = useSigner();
  return async () => {
    const sig = await sign({ title: "Resume all agents", detail: "They can buy within their rules again" });
    if (sig) await setKill(false, sig);
  };
}

/** The status line under the balance. */
export function AgentsStatus({ state, onOpen }: { state: AppState; onOpen: () => void }) {
  const open = state.pockets.filter((p) => !p.closedAt).length;
  const paused = !!state.killSwitch;
  return (
    <button className={`agents-status ${paused ? "is-paused" : ""}`} onClick={onOpen}
      aria-label={paused ? "All agents paused. Resume" : `${open} agents active. Pause all`}>
      <span className="status-state"><span className="status-dot" aria-hidden="true" />{paused ? "All paused" : `${open} agent${open === 1 ? "" : "s"} active`}</span>
      <span className="status-action"><Icon name={paused ? "play" : "pause"} size={13} stroke={2.6} />{paused ? "Resume" : "Pause"}</span>
    </button>
  );
}

/** Pinned while paused, on Home and Agents. */
export function PausedBanner({ setKill }: { setKill: SetKill }) {
  const resume = useResumeAll(setKill);
  const [busy, setBusy] = useState(false);
  return (
    <div className="paused-banner" role="status">
      <span className="paused-ico" aria-hidden="true"><Icon name="pause" size={16} stroke={2.6} /></span>
      <span className="grow stack-xs">
        <strong className="headline">All agents paused</strong>
        <span className="footnote">Nothing will be bought until you resume.</span>
      </span>
      <button className="btn sm primary" disabled={busy} onClick={async () => { setBusy(true); try { await resume(); } finally { setBusy(false); } }}>
        {busy ? <span className="spinner" /> : "Resume"}
      </button>
    </div>
  );
}

/** The control itself, in a small sheet. */
export function PauseSheet({ state, setKill, close }: { state: AppState; setKill: SetKill; close: () => void }) {
  const resume = useResumeAll(setKill);
  const [busy, setBusy] = useState(false);
  const paused = !!state.killSwitch;
  const open = state.pockets.filter((p) => !p.closedAt).length;
  const run = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); close(); } finally { setBusy(false); } };
  return (
    <div className="stack pause-sheet">
      <div className="pause-head">
        <span className={`pause-glyph ${paused ? "is-paused" : ""}`} aria-hidden="true"><Icon name={paused ? "pause" : "shield"} size={26} stroke={2.2} /></span>
        <h2 className="title-2">{paused ? "All agents paused" : `${open} agent${open === 1 ? "" : "s"} active`}</h2>
        <p className="subhead muted">
          {paused
            ? "Nothing will be bought. Your rules and money stay exactly as they are. Resuming needs your confirmation."
            : "Each one can buy only within its rules and its own budget. Pause stops them all at once, instantly."}
        </p>
      </div>
      {paused ? (
        <button className="btn primary block" disabled={busy} onClick={() => run(resume)}>
          {busy ? <span className="spinner" /> : <><Icon name="play" size={16} />Resume all agents</>}
        </button>
      ) : (
        <button className="btn danger block" disabled={busy} onClick={() => run(() => setKill(true))}>
          {busy ? <span className="spinner" /> : <><Icon name="pause" size={16} />Pause all agents</>}
        </button>
      )}
      <p className="caption muted" style={{ textAlign: "center" }}>
        {paused ? "Pending approvals stay waiting for you." : "You can resume any time."}
      </p>
    </div>
  );
}
