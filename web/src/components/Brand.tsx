/**
 * PayPal Pocket lockup: mark + "PayPal" wordmark + product line.
 *
 * PLACEHOLDER ARTWORK. The mark below is a stand-in drawn to the same proportions as the
 * reference. Drop the official PayPal SVGs into web/public/brand/ and switch MARK_SRC /
 * WORDMARK_SRC to their paths; nothing else needs to change.
 */
const MARK_SRC: string | null = null;     // e.g. "/brand/paypal-mark.svg"
const WORDMARK_SRC: string | null = null; // e.g. "/brand/paypal-wordmark-white.svg"

function Mark({ size }: { size: number }) {
  if (MARK_SRC) return <img src={MARK_SRC} width={size} height={size} alt="" />;
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      {/* back P: sky fill */}
      <path d="M17 13h13.5c6 0 9.5 3.4 8.6 8.7-1 6-5.6 9.3-11.6 9.3h-4.8L20.8 41H12z" fill="#60cdff" />
      {/* front P: outline */}
      <path d="M12.5 7h13c6 0 9.4 3.3 8.5 8.6-1 6-5.5 9.4-11.5 9.4h-4.8L16 35H7.4z" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinejoin="round" />
    </svg>
  );
}

export function BrandLockup({ product = "Pocket", compact = false }: { product?: string; compact?: boolean }) {
  const markSize = compact ? 30 : 40;
  return (
    <div className={`lockup ${compact ? "compact" : ""}`} aria-label={`PayPal ${product}`}>
      <Mark size={markSize} />
      <div className="lockup-text">
        {WORDMARK_SRC ? <img className="wordmark-img" src={WORDMARK_SRC} alt="PayPal" /> : <span className="wordmark">PayPal</span>}
        <span className="lockup-product">{product}</span>
      </div>
    </div>
  );
}
