import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { Mark } from "./Brand";
import { Icon } from "./Icon";

/**
 * PIN pad from the design: unlocks the app, and is how you SIGN (rule changes, new agents,
 * moving money, approving purchases). The server checks the PIN / Face ID on every signed
 * request, so this screen is the user's signature, not just a curtain.
 */

export type Signature = { pin: string } | { assertion: { id: string; clientDataJSON: string; authenticatorData: string; signature: string } };
export interface AuthStatus { hasPin: boolean; biometrics: boolean; lockedUntil?: string }

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

/** Registers this device's Face ID / fingerprint. The PIN signs the registration. */
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
  if (!cred) throw new Error("Face ID / fingerprint setup was cancelled.");
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
  if (!a) throw new Error("Face ID / fingerprint was cancelled.");
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
    if (!status?.biometrics) { setErr(bioOk ? "Unlock with your PIN once to turn on Face ID / fingerprint." : "Face ID / fingerprint isn't available on this device."); return; }
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
    mode === "setup" ? "You'll use it to sign for your agents" :
    mode === "sign" ? (detail ?? "Nothing changes until you sign") : "PayPal Pocket is locked";
  const deleteMode = pin.length > 0;

  if (offerBio) {
    return (
      <div className="lock">
        <LockArt />
        <div className="lock-offer">
          <Icon name="faceid" size={44} />
          <h2 className="title-2">Use Face ID or fingerprint?</h2>
          <p className="subhead">Sign for your agents with a glance or a touch. Your PIN still works.</p>
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
        <span>{err ?? sub}</span>
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
        <button aria-label="Use Face ID or fingerprint" className={`lock-aux ${status?.biometrics ? "" : "dim"}`} onClick={useBio} disabled={busy || mode === "setup"}>
          <Icon name="faceid" size={26} />
        </button>
      </div>
    </div>
  );
}

/** The design's hero: PayPal mark in rings with floating soft 3D objects (CSS stand-ins for the renders). */
function LockArt() {
  return (
    <div className="lock-art" aria-hidden="true">
      <span className="ring r2" />
      <span className="ring r1" />
      <span className="lock-mark"><Mark size={70} /></span>
      <span className="fl safe"><i /></span>
      <span className="fl coin" />
      <span className="fl coupon">%</span>
      <span className="fl cash"><i /></span>
      <span className="fl blur-a" />
      <span className="fl blur-b" />
    </div>
  );
}

/* ------------------------------------ Signer context ------------------------------------ */

type SignFn = (req: { title: string; detail?: string }) => Promise<Signature | null>;
const SignerCtx = createContext<SignFn>(async () => null);
export const useSigner = () => useContext(SignerCtx);

/** Provides `sign()` to the app: opens the pad over the screen and resolves with the signature. */
export function SignerProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<{ title: string; detail?: string; resolve: (s: Signature | null) => void } | null>(null);
  const sign = useCallback<SignFn>((r) => new Promise((resolve) => setReq({ ...r, resolve })), []);
  return (
    <SignerCtx.Provider value={sign}>
      {children}
      {req && (
        <LockScreen
          mode="sign"
          title={req.title}
          detail={req.detail}
          onDone={(s) => { req.resolve(s); setReq(null); }}
          onCancel={() => { req.resolve(null); setReq(null); }}
        />
      )}
    </SignerCtx.Provider>
  );
}

/** A button that asks for your PIN / Face ID, then hands the signature to `onSigned`. */
export function SignButton({ title, detail, onSigned, children, disabled, tone = "primary", className = "" }: {
  title: string; detail?: string; onSigned: (sig: Signature) => unknown; children: ReactNode; disabled?: boolean; tone?: "primary" | "danger"; className?: string;
}) {
  const sign = useSigner();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={`btn ${tone} block ${className}`}
      disabled={disabled || busy}
      onClick={async () => {
        const sig = await sign({ title, detail });
        if (!sig) return;
        setBusy(true);
        try { await onSigned(sig); } finally { setBusy(false); }
      }}
    >
      {busy ? <span className="spinner" /> : <Icon name="faceid" size={18} />}
      <span>{children}</span>
    </button>
  );
}
