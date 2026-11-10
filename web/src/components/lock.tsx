import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { Mark } from "./Brand";
import { Icon, type IconName } from "./Icon";
import { Money } from "./ui";

/**
 * PIN pad from the design: unlocks the app, and is how you SIGN (rule changes, new agents,
 * moving money, approving purchases). The server checks the PIN / Face ID on every signed
 * request, so this screen is the user's signature, not just a curtain.
 */

export type Signature = { pin: string } | { assertion: { id: string; clientDataJSON: string; authenticatorData: string; signature: string } };
export interface AuthStatus { hasPin: boolean; biometrics: boolean; lockedUntil?: string }

/* ------------------------------------ This device's unlock, by its own name ------------------------------------ */

/**
 * Signing uses passkeys (WebAuthn), which every platform unlocks its own way. Name it the way this device does, so
 * an Android phone never sees "Face ID": iPhone -> Face ID, Mac -> Touch ID, Android -> Fingerprint,
 * Windows -> Windows Hello, anything else -> Passkey. `label` for titles and buttons, `phrase` inside sentences.
 */
export function deviceUnlock(): { label: string; phrase: string; icon: IconName } {
  const ua = navigator.userAgent;
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || "";
  const touchMac = /Mac/i.test(platform) && navigator.maxTouchPoints > 1; // iPadOS reports itself as a Mac
  if (/iPhone|iPod/.test(ua)) return { label: "Face ID", phrase: "Face ID", icon: "faceid" };
  if (/iPad/.test(ua) || touchMac) return { label: "Face ID or Touch ID", phrase: "Face ID or Touch ID", icon: "faceid" };
  if (/Android/i.test(ua)) return { label: "Fingerprint", phrase: "your fingerprint", icon: "fingerprint" };
  if (/Mac/i.test(platform) || /Macintosh/.test(ua)) return { label: "Touch ID", phrase: "Touch ID", icon: "fingerprint" };
  if (/Win/i.test(platform)) return { label: "Windows Hello", phrase: "Windows Hello", icon: "fingerprint" };
  return { label: "Passkey", phrase: "a passkey", icon: "fingerprint" };
}

/* ------------------------------------ WebAuthn helpers ------------------------------------ */

const b64u = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s: string) => {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b + "===".slice((b.length + 3) % 4)), (c) => c.charCodeAt(0));
};

export async function biometricsAvailable(): Promise<boolean> {
  try {
    return !!window.PublicKeyCredential && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch {
    return false;
  }
}

/** Registers this device's passkey (Face ID, Touch ID, fingerprint, Windows Hello). The PIN signs the registration. */
export async function enrollBiometrics(pin: string) {
  const { challenge } = await api<{ challenge: string }>("/api/auth/challenge", {});
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: fromB64u(challenge),
      rp: { name: "PayPal Pocket", id: location.hostname },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "pocket", displayName: "PayPal Pocket" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -8 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "preferred" },
      attestation: "none",
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error(`${deviceUnlock().label} setup was cancelled.`);
  const r = cred.response as AuthenticatorAttestationResponse;
  const pk = r.getPublicKey();
  if (!pk) throw new Error("This browser can't share the biometric key.");
  await api("/api/auth/biometric", { auth: { pin }, credential: { id: cred.id, publicKey: b64u(pk), alg: r.getPublicKeyAlgorithm(), clientDataJSON: b64u(r.clientDataJSON) } });
}

/** Asks the phone for Face ID / fingerprint and returns a one-time signed assertion. */
export async function biometricSignature(): Promise<Signature> {
  const { challenge, credentialIds } = await api<{ challenge: string; credentialIds: string[] }>("/api/auth/challenge", {});
  const a = (await navigator.credentials.get({
    publicKey: {
      challenge: fromB64u(challenge),
      rpId: location.hostname,
      allowCredentials: credentialIds.map((id) => ({ type: "public-key" as const, id: fromB64u(id) })),
      userVerification: "required",
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!a) throw new Error(`${deviceUnlock().label} was cancelled.`);
  const r = a.response as AuthenticatorAssertionResponse;
  return { assertion: { id: a.id, clientDataJSON: b64u(r.clientDataJSON), authenticatorData: b64u(r.authenticatorData), signature: b64u(r.signature) } };
}

/* ------------------------------------ The pad ------------------------------------ */

type Mode = "setup" | "unlock" | "sign";

export function LockScreen({ mode, title, detail, onDone, onCancel }: {
  mode: Mode; title?: string; detail?: string;
  onDone: (sig: Signature) => void; onCancel?: () => void;
}) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [bioOk, setBioOk] = useState(false);
  const [pin, setPin] = useState("");
  const [first, setFirst] = useState<string | null>(null); // setup: first entry, waiting for confirm
  const [err, setErr] = useState<string | null>(null);
  const [shake, setShake] = useState(false);
  const [busy, setBusy] = useState(false);
  const [offerBio, setOfferBio] = useState<string | null>(null); // PIN to sign the enrolment with
  const unlock = deviceUnlock();

  useEffect(() => {
    api<AuthStatus>("/api/auth/status").then(setStatus).catch(() => setStatus({ hasPin: false, biometrics: false }));
    biometricsAvailable().then(setBioOk);
  }, []);

  const fail = (msg: string) => {
    setErr(msg);
    setShake(true);
    navigator.vibrate?.([40, 40, 40]);
    setTimeout(() => { setShake(false); setPin(""); }, 450);
  };

  const finish = (sig: Signature, usedPin?: string) => {
    // After a PIN, offer Face ID / fingerprint once if this device has it and it isn't set up.
    if (usedPin && bioOk && status && !status.biometrics && mode !== "sign") setOfferBio(usedPin);
    else onDone(sig);
  };

  const submit = async (code: string) => {
    setErr(null);
    if (mode === "setup") {
      if (!first) { setFirst(code); setPin(""); return; }
      if (code !== first) { setFirst(null); fail("PINs didn't match. Start again."); return; }
      setBusy(true);
      try {
        await api("/api/auth/pin", { pin: code });
        finish({ pin: code }, code);
      } catch (e) { fail((e as Error).message); } finally { setBusy(false); }
      return;
    }
    // unlock and sign: check the PIN with the server first, so a wrong PIN shakes here.
    setBusy(true);
    try {
      await api("/api/auth/unlock", { auth: { pin: code } });
      finish({ pin: code }, code);
    } catch (e) { fail((e as Error).message); } finally { setBusy(false); }
  };

  const press = (d: string) => {
    if (busy || pin.length >= 4) return;
    const next = pin + d;
    setPin(next);
    navigator.vibrate?.(8);
    if (next.length === 4) setTimeout(() => submit(next), 120);
  };

  const useBio = async () => {
    if (!status?.biometrics) { setErr(bioOk ? `Unlock with your PIN once to turn on ${unlock.label}.` : `${unlock.label} isn't available here. Use your PIN.`); return; }
    setErr(null);
    setBusy(true);
    try {
      const sig = await biometricSignature();
      if (mode === "unlock") await api("/api/auth/unlock", { auth: sig });
      onDone(sig);
    } catch (e) { fail((e as Error).message); } finally { setBusy(false); }
  };

  const heading =
    mode === "setup" ? (first ? "Enter it again" : "Create a 4-digit PIN") :
    mode === "sign" ? (title ?? "Sign with your PIN") : "Enter your PIN";
  const sub =
    mode === "setup" ? "You'll use it to approve what your agents do" :
    mode === "sign" ? (detail ?? "Nothing changes until you approve") : "PayPal Pocket is locked";
  const deleteMode = pin.length > 0;

  if (offerBio) {
    return (
      <div className="lock">
        <LockArt />
        <div className="lock-offer">
          <Icon name={unlock.icon} size={44} />
          <h2 className="title-2">Use {unlock.label}?</h2>
          <p className="subhead">Approve changes with {unlock.phrase}. Your PIN still works.</p>
          <button className="btn primary block" disabled={busy} onClick={async () => {
            setBusy(true);
            try { await enrollBiometrics(offerBio); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); onDone({ pin: offerBio }); }
          }}>{busy ? <span className="spinner" /> : "Turn on"}</button>
          <button className="btn ghost block" onClick={() => onDone({ pin: offerBio })}>Not now</button>
        </div>
      </div>
    );
  }

  return (
    <div className={`lock ${mode === "sign" ? "lock-sign" : ""}`} role="dialog" aria-modal="true" aria-label={heading}>
      <LockArt />
      <div className="lock-text">
        <strong>{heading}</strong>
        <span className={err ? "error" : ""} role={err ? "alert" : undefined}>{err ?? sub}</span>
      </div>
      <div className={`lock-dots ${shake ? "shake" : ""} ${err ? "error" : ""}`} aria-label={`${pin.length} of 4 digits entered`}>
        {[0, 1, 2, 3].map((i) => <i key={i} className={i < pin.length ? "on" : ""} />)}
      </div>
      <div className="lock-pad">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => <button key={d} onClick={() => press(d)} disabled={busy}>{d}</button>)}
        <button
          aria-label={deleteMode ? "Delete" : mode === "sign" ? "Cancel" : "Locked"}
          onClick={() => (deleteMode ? setPin(pin.slice(0, -1)) : onCancel?.())}
          className="lock-aux"
        >
          {deleteMode ? <Icon name="backspace" size={24} /> : mode === "sign" ? <span className="lock-cancel">Cancel</span> : <Icon name="lock" size={24} />}
        </button>
        <button onClick={() => press("0")} disabled={busy}>0</button>
        {/* Only when this device can do it: otherwise the key stays empty, like the blank key on an iPhone keypad. */}
        {bioOk && mode !== "setup" ? (
          <button aria-label={`Use ${unlock.label}`} className={`lock-aux ${status?.biometrics ? "" : "dim"}`} onClick={useBio} disabled={busy}>
            <Icon name={unlock.icon} size={26} />
          </button>
        ) : <span className="lock-aux" aria-hidden="true" />}
      </div>
    </div>
  );
}

/** The PayPal mark, nothing else: the PIN screen stays calm and matches the rest of the app. */
function LockArt() {
  return <span className="lock-mark" aria-hidden="true"><Mark size={44} /></span>;
}

/* ------------------------------------ Signer context ------------------------------------ */

/** What the person is approving, shown Apple Pay style before the PIN / Face ID step. */
export interface Approval {
  amount?: number;
  rows: { label: string; value: string; tone?: "ok" | "danger" }[];
  note?: string;
}
type SignReq = { title: string; detail?: string; approval?: Approval };
type SignFn = (req: SignReq) => Promise<Signature | null>;
const SignerCtx = createContext<SignFn>(async () => null);
export const useSigner = () => useContext(SignerCtx);

/** Words for the confirmation moment after a signature: what is happening, then what happened. */
export interface Progress { working: string; done: string }
type RunFn = (p: Progress, fn: () => Promise<unknown>) => Promise<boolean>;
const ProgressCtx = createContext<RunFn>(async (_p, fn) => { await fn(); return true; });

type Overlay = { phase: "working" | "done" | "error" | "leaving"; text: string; slow?: boolean };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Provides `sign()` to the app: shows the summary (if any), then the pad, and resolves with the signature. */
export function SignerProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<(SignReq & { resolve: (s: Signature | null) => void; stage: "review" | "pin" }) | null>(null);
  const sign = useCallback<SignFn>((r) => new Promise((resolve) => setReq({ ...r, resolve, stage: r.approval ? "review" : "pin" })), []);
  const cancel = () => { req?.resolve(null); setReq(null); };

  // The confirmation moment: blur + glow + "working" pill, then a check only once the server confirms.
  const [ov, setOv] = useState<Overlay | null>(null);
  const run = useCallback<RunFn>(async (p, fn) => {
    setOv({ phase: "working", text: p.working });
    const slow = setTimeout(() => setOv((o) => (o && o.phase === "working" ? { ...o, slow: true } : o)), 10_000);
    try {
      await Promise.all([fn(), wait(900)]); // at least long enough to read, never faster than the real request
      clearTimeout(slow);
      setOv({ phase: "done", text: p.done });
      navigator.vibrate?.(15);
      await wait(1500);
      setOv((o) => (o?.phase === "done" ? { ...o, phase: "leaving" } : o));
      await wait(320);
      setOv((o) => (o?.phase === "leaving" ? null : o));
      return true;
    } catch (e) {
      clearTimeout(slow);
      setOv({ phase: "error", text: (e as Error).message || "That didn't go through. Nothing changed." });
      return false;
    }
  }, []);

  return (
    <SignerCtx.Provider value={sign}>
    <ProgressCtx.Provider value={run}>
      {children}
      {ov && <ProgressOverlay ov={ov} close={() => setOv(null)} />}
      {req?.stage === "review" && req.approval && (
        <ApprovalSheet title={req.title} approval={req.approval} onContinue={() => setReq({ ...req, stage: "pin" })} onCancel={cancel} />
      )}
      {req?.stage === "pin" && (
        <LockScreen
          mode="sign"
          title={req.title}
          detail={req.detail}
          onDone={(s) => { req.resolve(s); setReq(null); }}
          onCancel={cancel}
        />
      )}
    </ProgressCtx.Provider>
    </SignerCtx.Provider>
  );
}

function ProgressOverlay({ ov, close }: { ov: Overlay; close: () => void }) {
  const icon = ov.phase === "working"
    ? <span className="ov-spin" aria-hidden="true" />
    : ov.phase === "error"
      ? <span className="ov-icon err" aria-hidden="true"><Icon name="alert" size={14} stroke={2.6} /></span>
      : <span className="ov-icon ok" aria-hidden="true"><Icon name="check" size={14} stroke={3} /></span>;
  // Errors: short headline in the pill, the detail underneath.
  const [head, ...rest] = ov.phase === "error" ? ov.text.replace(/\bError:\s*/g, "").split(/(?<=\.)\s+/) : [ov.text];
  return (
    <div className={`progress-ov ${ov.phase}`} onClick={ov.phase === "done" ? close : undefined}>
      <div className="ov-glow" aria-hidden="true" />
      <div className="ov-center">
        <div className="ov-pill" key={ov.phase === "leaving" ? "done" : ov.phase} role={ov.phase === "error" ? "alert" : "status"} aria-live="polite">
          {icon}<span>{head}</span>
        </div>
        {ov.phase === "error" && <p className="ov-note">{rest.length ? `${rest.join(" ")} ` : ""}Nothing was charged or changed.</p>}
        {ov.slow && ov.phase === "working" && <p className="ov-note">Still working. You can close this; the result will show in the app.</p>}
        {(ov.phase === "error" || ov.slow) && <button className="btn sm cta ov-close" autoFocus onClick={close}>Close</button>}
      </div>
    </div>
  );
}

function ApprovalSheet({ title, approval, onContinue, onCancel }: { title: string; approval: Approval; onContinue: () => void; onCancel: () => void }) {
  // Name the step that comes next truthfully: this device's unlock if it's set up, otherwise the PIN.
  const [bio, setBio] = useState(false);
  useEffect(() => { api<AuthStatus>("/api/auth/status").then((s) => setBio(!!s.biometrics)).catch(() => {}); }, []);
  const unlock = deviceUnlock();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div className="sheet-scrim approve-scrim" onClick={onCancel}>
      <div className="sheet approve-sheet" role="dialog" aria-modal="true" aria-labelledby="approve-title" onClick={(e) => e.stopPropagation()}>
        <div className="approve-head">
          <Mark size={26} />
          <strong id="approve-title" className="headline grow">{title}</strong>
          <button className="icon-btn sheet-close-inline" aria-label="Cancel" onClick={onCancel}><Icon name="close" size={18} /></button>
        </div>
        {approval.amount !== undefined && <div className="approve-amount"><Money value={approval.amount} size="title" /></div>}
        <dl className="approve-rows">
          {approval.rows.map((r) => (
            <div key={r.label} className="approve-row">
              <dt>{r.label}</dt>
              <dd className={r.tone ? `${r.tone}-text` : ""}>{r.value}</dd>
            </div>
          ))}
        </dl>
        {approval.note && <p className="footnote muted">{approval.note}</p>}
        <button className="btn primary block" onClick={onContinue} autoFocus><Icon name={bio ? unlock.icon : "lock"} size={18} />Confirm with {bio ? unlock.label : "PIN"}</button>
        <button className="btn ghost block" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/** A button that shows the summary, asks for your PIN / Face ID, then hands the signature to `onSigned`. */
export function SignButton({ title, detail, approval, progress, onSigned, children, disabled, tone = "primary", className = "" }: {
  title: string; detail?: string; approval?: Approval;
  /** When given, the signed action plays the confirmation moment. `onSigned` must throw on failure. */
  progress?: Progress;
  onSigned: (sig: Signature) => unknown; children: ReactNode; disabled?: boolean; tone?: "primary" | "danger"; className?: string;
}) {
  const sign = useSigner();
  const run = useContext(ProgressCtx);
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={`btn ${tone} block ${className}`}
      disabled={disabled || busy}
      onClick={async () => {
        const sig = await sign({ title, detail, approval });
        if (!sig) return;
        setBusy(true);
        try {
          if (progress) await run(progress, () => Promise.resolve(onSigned(sig)));
          else await onSigned(sig);
        } finally { setBusy(false); }
      }}
    >
      {/* The button says what it does; how you confirm is named on the next step. */}
      {busy && <span className="spinner" />}
      <span>{children}</span>
    </button>
  );
}
