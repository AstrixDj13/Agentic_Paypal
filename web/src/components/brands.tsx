import type { ReactNode } from "react";

/**
 * Merchant looks for subscription and bill pockets, like passes in Apple Wallet: the card takes the merchant's
 * colours so you know it before you read it. The marks are simple drawn glyphs in the brand's colours (not the
 * merchants' trademarked logos); the merchants themselves are simulated in this demo.
 * Shopping agents keep the Pocket palette, so the two kinds of card stay distinct.
 */

export type BrandId = "netflix" | "spotify" | "applemusic" | "icloud" | "gym" | "power" | "study" | "gas" | "phone";

const svg = (children: ReactNode, fill = false) => (
  <svg viewBox="0 0 24 24" width="100%" height="100%" fill={fill ? "currentColor" : "none"} stroke={fill ? "none" : "currentColor"}
    strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);

interface Brand {
  /** Names the merchant goes by (matched case-insensitively against the pocket's name). */
  names: string[];
  /** The merchant colour Debjit's catalog stores on the pocket (a fallback when the pocket was renamed). */
  color: string;
  glyph: ReactNode;
  /** The emblem tile on the card. Omitted: a frosted tile with a white glyph. */
  tile?: { bg: string; fg: string; round?: boolean };
  /** The round avatar. Omitted: the card's gradient with a white glyph. */
  avatar?: { bg: string; fg: string };
}

export const BRANDS: Record<BrandId, Brand> = {
  netflix: {
    names: ["netflix"], color: "#e5484d",
    glyph: <span className="brand-letter">N</span>,
    tile: { bg: "#000", fg: "#e50914" }, avatar: { bg: "#000", fg: "#e50914" },
  },
  spotify: {
    names: ["spotify"], color: "#19a35b",
    glyph: svg(<><path d="M5.5 9.2c4.3-1.4 9-1 13 1.1" /><path d="M6.6 12.7c3.5-1 7.2-.7 10.3.9" /><path d="M7.7 16c2.6-.7 5.2-.5 7.4.6" /></>),
    tile: { bg: "#1ed760", fg: "#000", round: true }, avatar: { bg: "#1ed760", fg: "#000" },
  },
  applemusic: {
    names: ["apple music"], color: "#e5489b",
    glyph: svg(<><path d="M9.5 17V6.6l9.5-2.1v10.2" fill="none" stroke="currentColor" strokeWidth={2.2} /><circle cx="7" cy="17" r="2.6" /><circle cx="16.5" cy="14.8" r="2.6" /></>, true),
    tile: { bg: "#fff", fg: "#fa233b" },
  },
  icloud: {
    names: ["icloud", "icloud+"], color: "#0070e0",
    glyph: svg(<path d="M7.2 18.5h10a4.2 4.2 0 0 0 .5-8.4 5.6 5.6 0 0 0-10.8-.9A4.7 4.7 0 0 0 7.2 18.5z" />, true),
    tile: { bg: "#fff", fg: "#2d7ff9" },
  },
  gym: { names: ["northside gym"], color: "#ff7a1a", glyph: svg(<><path d="M6.5 7v10M17.5 7v10M3.5 9.5v5M20.5 9.5v5M6.5 12h11" /></>) },
  power: { names: ["city power"], color: "#d4a106", glyph: svg(<path d="M13.2 2.5 4.8 13.6h6.4l-1 7.9 8.4-11.1h-6.4z" />, true) },
  study: { names: ["studypro"], color: "#7c4dff", glyph: svg(<><path d="M2.5 9 12 4.5 21.5 9 12 13.5z" /><path d="M6.5 11v4.6c3.3 2.4 7.7 2.4 11 0V11" /></>) },
  gas: { names: ["metro gas"], color: "#0aa5a5", glyph: svg(<path d="M12 2.8c.9 3.4 5.2 5.6 5.2 10.3a5.2 5.2 0 0 1-10.4 0c0-2.3 1.2-3.8 2.4-4.8.2 1.7 1 2.7 2.1 3.1-.1-3.4.2-5.9.7-8.6z" />, true) },
  phone: { names: ["mobile plan"], color: "#6b7280", glyph: svg(<><rect x="7" y="2.8" width="10" height="18.4" rx="2.6" /><path d="M11 17.6h2" /></>) },
};

export const isBrand = (tone: string | undefined): tone is BrandId => !!tone && tone in BRANDS;

/** A subscription or bill pocket's merchant, from its name (or, if renamed, the merchant colour it was created with). */
export function brandOf(agent: { name?: string; color?: string; kind?: string } | undefined): BrandId | undefined {
  if (agent?.kind !== "recurring") return undefined;
  const n = (agent.name ?? "").trim().toLowerCase();
  const ids = Object.keys(BRANDS) as BrandId[];
  return ids.find((id) => BRANDS[id].names.includes(n)) ?? ids.find((id) => BRANDS[id].color === agent.color?.toLowerCase());
}

/** The emblem on the card: the merchant's mark on its tile. */
export function BrandTile({ id }: { id: BrandId }) {
  const b = BRANDS[id];
  return (
    <span className={`brand-tile ${b.tile ? "" : "frost"} ${b.tile?.round ? "round" : ""}`}
      style={b.tile ? { background: b.tile.bg, color: b.tile.fg } : undefined} aria-hidden="true">
      <span className="brand-glyph">{b.glyph}</span>
    </span>
  );
}

/** The merchant's mark for a round avatar (the avatar supplies the size). */
export function BrandAvatarGlyph({ id }: { id: BrandId }) {
  return <span className="brand-glyph">{BRANDS[id].glyph}</span>;
}

export const brandAvatarStyle = (id: BrandId) => {
  const a = BRANDS[id].avatar;
  return a ? { background: a.bg, color: a.fg } : undefined;
};
