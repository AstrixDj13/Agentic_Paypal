import { useEffect, useState } from "react";
import { api, type AppState } from "../api";
import { Icon, type IconName } from "./Icon";
import { Mark } from "./Brand";
import { deviceUnlock, type AuthStatus } from "./lock";
import { useResumeAll, type SetKill } from "./pause";
import { signOut } from "./account";
import { disablePush, enablePush, pushState } from "../push";
import { Switch } from "./ui";

/**
 * Account, the way Apple apps do it: a round avatar in Home's corner opens this sheet, laid out like iOS Settings
 * (an identity header, then short grouped lists). It gathers what had no home: who you're signed in as, security,
 * notifications, privacy, the Black Box records and sign out. Nothing here moves money.
 */

/** Initials from an email's name part ("anubhav.goswami@…" -> "AG"); none without an account. */
export function initialsOf(email?: string | null) {
  const name = (email ?? "").split("@")[0];
  const parts = name.split(/[._\-+]+/).filter((w) => /[a-z]/i.test(w));
  return parts.slice(0, 2).map((w) => w.replace(/[^a-z]/gi, "").charAt(0).toUpperCase()).join("");
}

/** The avatar button in Home's top-right corner. */
export function AccountButton({ email, onOpen }: { email?: string | null; onOpen: () => void }) {
  const ini = initialsOf(email);
  return (
    <button className="glass-circle account-btn" onClick={onOpen} aria-label={email ? `Account: ${email}` : "Account and settings"}>
      {ini ? <span className="account-ini">{ini}</span> : <Icon name="user" size={22} />}
    </button>
  );
}

/** One settings row: a plain line icon (the app's one icon style, no coloured tiles), title, detail, and a value or chevron. */
function Row({ icon, title, detail, onClick, trailing }: {
  icon: IconName; title: string; detail?: string; onClick?: () => void; trailing?: React.ReactNode;
}) {
  const body = (
    <>
      <span className="set-ico" aria-hidden="true"><Icon name={icon} size={20} stroke={1.9} /></span>
      <span className="set-text">
        <span className="set-title">{title}</span>
        {detail && <span className="set-detail">{detail}</span>}
      </span>
      {trailing ?? (onClick && <Icon name="chevronRight" size={16} className="set-chev" />)}
    </>
  );
  return onClick ? <button type="button" className="set-row" onClick={onClick}>{body}</button> : <div className="set-row">{body}</div>;
}

export function AccountSheet({ state, email, signedIn, act, setKill, go, show }: {
  state: AppState; email?: string | null; signedIn: boolean;
  act: (fn: () => Promise<unknown>, ok?: string) => unknown; setKill: SetKill;
  go: (path: string) => void; show: (t: string, e?: boolean) => void;
}) {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [push, setPush] = useState<"unsupported" | "denied" | "on" | "off" | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  useEffect(() => {
    api<AuthStatus>("/api/auth/status").then(setAuth).catch(() => {});
    pushState().then(setPush).catch(() => setPush("unsupported"));
  }, []);

  const ini = initialsOf(email);
  const unlock = deviceUnlock();
  const resume = useResumeAll(setKill); // resuming gives spending power back: it asks for your PIN
  const open = state.pockets.filter((p) => !p.closedAt).length;
  const records = state.purchases.length;
  const connect = () => act(async () => {
    const { approveUrl } = await api<{ approveUrl: string }>("/api/paypal/connect", {});
    location.href = approveUrl;
  });
  const togglePush = async () => {
    setPushBusy(true);
    try {
      if (push === "on") { await disablePush(); show("Notifications are off."); }
      else { await enablePush(); show("Notifications are on. We sent a test."); }
      setPush(await pushState());
    } catch (e) { show((e as Error).message, true); } finally { setPushBusy(false); }
  };

  return (
    <div className="stack account-sheet">
      <div className="acct-head">
        <span className="acct-avatar" aria-hidden="true">{ini || <Icon name="user" size={34} />}</span>
        <h2 className="title-2">{email ?? "This device"}</h2>
        <p className="footnote muted">{signedIn ? "Signed in to PayPal Pocket" : "Not signed in: your agents live on this device"}</p>
        {state.vault
          ? <span className="acct-paypal"><Mark size={16} /><span>PayPal connected</span><Icon name="check" size={14} stroke={2.6} className="ok-text" /></span>
          : <button className="btn sm primary" onClick={connect}><Mark size={16} mono />Connect PayPal</button>}
      </div>

      <section className="set-group" aria-label="Spending">
        <Row icon={state.killSwitch ? "play" : "pause"} title="Pause all agents"
          detail={state.killSwitch ? "Nothing will be bought until you resume." : `${open} agent${open === 1 ? "" : "s"} can buy within their rules.`}
          trailing={<Switch on={!!state.killSwitch} onChange={() => (state.killSwitch ? resume() : setKill(true))} label="Pause all agents" tone="danger" />} />
      </section>

      <section className="set-group" aria-label="Security">
        <Row icon="lock" title="PIN" detail={auth ? (auth.hasPin ? "Signs every payment and rule change" : "Not set up") : "…"}
          trailing={<span className="set-value">{auth?.hasPin ? "On" : "Off"}</span>} />
        <Row icon={unlock.icon} title={unlock.label} detail="A passkey on this device, instead of your PIN"
          trailing={<span className="set-value">{auth ? (auth.biometrics ? "On" : "Off") : "…"}</span>} />
      </section>

      <section className="set-group" aria-label="Notifications and privacy">
        <Row icon="bell" title="Notifications"
          detail={push === "unsupported" ? "On iPhone, add Pocket to your Home Screen first" : push === "denied" ? "Blocked in your browser settings" : "Urgent asks, plus one weekly check-in"}
          trailing={push === "unsupported" || push === "denied" || push === null ? <span className="set-value">Off</span>
            : <Switch on={push === "on"} onChange={() => { if (!pushBusy) togglePush(); }} label="Notifications" />} />
        <Row icon="sparkles" title="What Pocket knows" detail="What it learned, your check-in, and how to wipe it" onClick={() => go("/knows")} />
      </section>

      <section className="set-group" aria-label="Records">
        <Row icon="box" title="Black Box" detail={`A tamper-proof record of every decision${records ? ` · ${records} purchase${records === 1 ? "" : "s"}` : ""}`} onClick={() => go("/console")} />
      </section>

      {signedIn && (
        <section className="set-group">
          <button type="button" className="set-row set-danger" onClick={signOut}><span className="set-title">Sign out</span></button>
        </section>
      )}
      <p className="caption muted acct-foot">PayPal Pocket · PayPal sandbox (test money)</p>
    </div>
  );
}
