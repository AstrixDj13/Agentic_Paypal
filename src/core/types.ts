// Shared domain types for Agent Pocket + Black Box.

/** Product attributes compared field by field, e.g. { brand: "nike", size_us: "10" }. */
export type Attributes = Record<string, string>;

/** Structured rules the user approves and signs once. */
export interface Mandate {
  id: string;
  pocketId: string;
  /** The user's original words, kept verbatim for the record. */
  instruction: string;
  /** Short description of what may be bought, e.g. "road running shoes". */
  item: string;
  /** Hard constraints. Each key must match exactly (after normalisation) on the agent's claim. */
  required: Attributes;
  /** Allowed values for a key, e.g. { brand: ["nike", "adidas"] }. */
  allowed: Record<string, string[]>;
  maxUnitPrice: number;
  currency: "USD";
  maxQuantity: number;
  /** Words that must not appear in what is bought, e.g. ["paprika"] for "chilli powder, not paprika". */
  avoid?: string[];
  /** How the user described the product ("white leather low-tops, gum sole"). The agent searches with it. */
  description?: string;
  /** sha256 of a reference photo the user attached; the photo itself is stored separately. */
  refImage?: string;
  /** Merchant ids the agent may buy from. Empty = any agent-ready merchant. */
  merchants: string[];
  expiresAt: string; // ISO
  createdAt: string; // ISO
}

export interface SignedMandate {
  mandate: Mandate;
  /** Ed25519 public key, base64 SPKI DER. */
  publicKey: string;
  /** Ed25519 signature over canonical JSON of `mandate`, base64. */
  signature: string;
}

/** "Ask me about anything" = every purchase needs a tap; "only ask about money" = buys inside the rules on its own. */
export type AskMode = "anything" | "money";

/**
 * A pocket is an agent: its own money, its own name and colour, one job (one active signed mandate).
 * Fields after `currency` are optional so older saved state still loads.
 */
export interface Pocket {
  id: string;
  name: string;
  balance: number;
  currency: "USD";
  color?: string;
  askMode?: AskMode;
  /** Per-agent kill switch. */
  paused?: boolean;
  /** "Take a look before I buy": seconds the agent waits (and pings the phone) before an in-rules purchase. 0 = off. */
  lookFirstSec?: number;
  /** Closed agents never buy again. Their purchases and records stay. Restoring needs the user's PIN. */
  closedAt?: string;
  /** Chat messages after this time count as unread. */
  lastReadAt?: string;
  createdAt?: string;
}

/** What the agent says it is buying. The guard only ever sees this claim. */
export interface ProposedOrder {
  mandateId: string;
  merchantId: string;
  productId: string;
  title: string;
  attributes: Attributes;
  unitPrice: number;
  quantity: number;
  currency: "USD";
  reasoning: string;
}

export interface GuardState {
  killSwitch: boolean;
  maxPurchasesPerDay: number;
  purchasesToday: number;
  /** Merchants the user has already approved at least once. */
  knownMerchants: string[];
  /** The user set this agent to "ask me about anything": every purchase needs a tap. */
  askEveryPurchase?: boolean;
}

/** What the product page actually said when the agent looked at it. */
export interface PageSnapshot {
  url: string;
  merchantId: string;
  productId: string;
  title: string;
  attributes: Attributes;
  unitPrice: number;
  listingText: string;
  capturedAt: string;
}

/** What actually arrived, read from the user's photo by a vision model. */
export interface DeliveryReading {
  attributes: Attributes;
  /** 0..1 confidence reported by the vision step. */
  confidence: number;
  photoRef: string;
}
