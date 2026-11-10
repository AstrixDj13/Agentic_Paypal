import { useState } from "react";
import { api } from "../api";
import { Mark } from "./Brand";

/**
 * Sign in / create account. The password opens your account; your PIN (or Face ID) is still
 * what approves spending, so it's asked next, on the PIN pad.
 */
export function AccountScreen({ onDone }: { onDone: (user: { id: string; email: string; imported?: boolean }) => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ user: { id: string; email: string; imported?: boolean } }>(`/api/account/${mode}`, { email, password });
      onDone(r.user);
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lock account-screen" role="dialog" aria-modal="true" aria-label={mode === "login" ? "Sign in" : "Create account"}>
      <span className="lock-mark" aria-hidden="true"><Mark size={44} /></span>
      <div className="lock-text">
        <strong>{mode === "login" ? "Sign in to Pocket" : "Create your Pocket"}</strong>
        <span className={err ? "error" : ""}>{err ?? (mode === "login" ? "Your agents, rules and Black Box are kept in your account." : "Your PIN is set next. It approves every purchase.")}</span>
      </div>
      <form className="account-form" onSubmit={submit}>
        <label className="field">Email
          <input className="input" type="email" autoComplete="email" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">Password
          <input className="input" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {mode === "signup" && <p className="caption muted">At least 8 characters.</p>}
        <button className="btn primary block" type="submit" disabled={busy || !email.trim() || password.length < (mode === "signup" ? 8 : 1)}>
          {busy ? <span className="spinner" /> : mode === "login" ? "Sign in" : "Create account"}
        </button>
        <button className="btn ghost block" type="button" onClick={() => { setMode(mode === "login" ? "signup" : "login"); setErr(null); }}>
          {mode === "login" ? "New here? Create an account" : "Have an account? Sign in"}
        </button>
      </form>
    </div>
  );
}

export async function signOut() {
  try { await api("/api/account/logout", {}); } catch { /* already signed out */ }
  try { sessionStorage.removeItem("pocket.unlocked"); } catch { /* storage blocked */ }
  location.assign("/");
}
