/**
 * Auth token system for apiary share links and session management.
 *
 * Two token types:
 * - Share tokens — embedded in URLs, map to an authority tier.
 *   Anyone with the link joins at that tier.
 * - Session tokens — issued on join, identify a participant + authority.
 *   Used for all subsequent API calls.
 */

import { randomBytes } from "node:crypto";
import type { AuthorityLevel } from "../core/types.js";

interface SessionData {
  participantId: string;
  authority: AuthorityLevel;
  createdAt: number;
  expiresAt: number;
}

interface ShareTokenData {
  authority: AuthorityLevel;
  createdAt: number;
  expiresAt: number;
}

export interface TokenManagerOptions {
  /** Session token TTL in ms. Default: 24 hours. */
  sessionTtlMs?: number;
  /** Share token TTL in ms. Default: 1 hour. */
  shareTtlMs?: number;
}

const DEFAULT_SESSION_TTL = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_SHARE_TTL = 60 * 60 * 1000; // 1h

export class TokenManager {
  /** share token → share data */
  private _shareTokens = new Map<string, ShareTokenData>();
  /** session token → participant data */
  private _sessionTokens = new Map<string, SessionData>();

  private _sessionTtlMs: number;
  private _shareTtlMs: number;

  constructor(options?: TokenManagerOptions) {
    this._sessionTtlMs = options?.sessionTtlMs ?? DEFAULT_SESSION_TTL;
    this._shareTtlMs = options?.shareTtlMs ?? DEFAULT_SHARE_TTL;
  }

  /**
   * Generate a share token at the given authority tier.
   * Callers can only generate tokens at their own tier or below.
   */
  generateShareToken(callerAuthority: AuthorityLevel, targetAuthority: AuthorityLevel): string | null {
    if (!canGrant(callerAuthority, targetAuthority)) return null;
    const token = randomBytes(16).toString("hex");
    const now = Date.now();
    this._shareTokens.set(token, {
      authority: targetAuthority,
      createdAt: now,
      expiresAt: now + this._shareTtlMs,
    });
    return token;
  }

  /** Validate a share token and return its authority level. Deletes if expired. */
  validateShareToken(token: string): AuthorityLevel | null {
    const data = this._shareTokens.get(token);
    if (!data) return null;
    if (Date.now() > data.expiresAt) {
      this._shareTokens.delete(token);
      return null;
    }
    return data.authority;
  }

  /** Create a session token for a participant. */
  createSessionToken(participantId: string, authority: AuthorityLevel): string {
    const token = randomBytes(16).toString("hex");
    const now = Date.now();
    this._sessionTokens.set(token, {
      participantId,
      authority,
      createdAt: now,
      expiresAt: now + this._sessionTtlMs,
    });
    return token;
  }

  /** Validate a session token and return participant data. Deletes if expired. */
  validateSessionToken(token: string): SessionData | null {
    const data = this._sessionTokens.get(token);
    if (!data) return null;
    if (Date.now() > data.expiresAt) {
      this._sessionTokens.delete(token);
      return null;
    }
    return data;
  }

  /** Revoke a session token (on disconnect). */
  revokeSessionToken(token: string): void {
    this._sessionTokens.delete(token);
  }

  /** Update the authority level for an existing session. */
  updateSessionAuthority(token: string, newAuthority: AuthorityLevel): boolean {
    const data = this._sessionTokens.get(token);
    if (!data) return false;
    data.authority = newAuthority;
    return true;
  }

  /** Find a session token by participant ID (for cleanup). */
  findSessionByParticipant(participantId: string): string | null {
    for (const [token, data] of this._sessionTokens) {
      if (data.participantId === participantId) return token;
    }
    return null;
  }

  /** Rotate a session token: create new with same participant data, delete old. */
  rotateSessionToken(oldToken: string): { newToken: string; data: SessionData } | null {
    const data = this._sessionTokens.get(oldToken);
    if (!data) return null;
    if (Date.now() > data.expiresAt) {
      this._sessionTokens.delete(oldToken);
      return null;
    }
    this._sessionTokens.delete(oldToken);
    const newToken = randomBytes(16).toString("hex");
    const now = Date.now();
    const newData: SessionData = {
      participantId: data.participantId,
      authority: data.authority,
      createdAt: now,
      expiresAt: now + this._sessionTtlMs,
    };
    this._sessionTokens.set(newToken, newData);
    return { newToken, data: newData };
  }

  /** Sweep expired tokens from both maps. */
  pruneExpired(): void {
    const now = Date.now();
    for (const [token, data] of this._shareTokens) {
      if (now > data.expiresAt) this._shareTokens.delete(token);
    }
    for (const [token, data] of this._sessionTokens) {
      if (now > data.expiresAt) this._sessionTokens.delete(token);
    }
  }
}

/** Authority tier ordering: admin > member > guest. */
const TIER_ORDER: Record<AuthorityLevel, number> = {
  admin: 2,
  member: 1,
  guest: 0,
};

/** Can a caller at `callerLevel` grant authority at `targetLevel`? */
function canGrant(callerLevel: AuthorityLevel, targetLevel: AuthorityLevel): boolean {
  return TIER_ORDER[callerLevel] >= TIER_ORDER[targetLevel];
}

/** Build a share URL from a base URL and token. */
export function buildShareUrl(baseUrl: string, token: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

/** Extract a token from a share URL. */
export function extractToken(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("token");
  } catch {
    return null;
  }
}
