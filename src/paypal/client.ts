import { randomUUID } from "node:crypto";

/** Minimal PayPal REST client for the sandbox. One instance per REST app (store, cover pool). */

export const SANDBOX_BASE = "https://api-m.sandbox.paypal.com";

export class PayPalError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: unknown,
  ) {
    super(`PayPal ${status} on ${path}: ${JSON.stringify(body)}`);
  }
}

interface Token {
  value: string;
  scopes: string[];
  expiresAt: number;
}

export class PayPalClient {
  private token?: Token;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly base: string = SANDBOX_BASE,
  ) {
    if (!clientId || !clientSecret) throw new Error("PayPal client id/secret missing. Fill in .env (see .env.example).");
  }

  /** OAuth2 client-credentials token. The scope list tells us which APIs this app may call. */
  async getToken(): Promise<Token> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token;
    const res = await fetch(`${this.base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const body = (await res.json()) as any;
    if (!res.ok) throw new PayPalError(res.status, "/v1/oauth2/token", body);
    this.token = { value: body.access_token, scopes: String(body.scope ?? "").split(" "), expiresAt: Date.now() + body.expires_in * 1000 };
    return this.token;
  }

  async request<T = any>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    const { value } = await this.getToken();
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${value}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": randomUUID(), // idempotency key
        Prefer: "return=representation",
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const parsed = text ? safeJson(text) : {};
    if (!res.ok) throw new PayPalError(res.status, path, parsed);
    return parsed as T;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function approveLink(resource: { links?: { rel: string; href: string }[] }): string | undefined {
  return resource.links?.find((l) => l.rel === "approve" || l.rel === "payer-action")?.href;
}
