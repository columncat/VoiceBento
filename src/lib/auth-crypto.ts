/**
 * 세션 쿠키용 AES-256-GCM 암호화 — Web Crypto API 사용.
 * Edge runtime 및 Node runtime 양쪽에서 동작 (미들웨어와 라우트 모두에서 import 가능).
 */

export interface SessionPayload {
  /** 만료 시각 (unix seconds). */
  exp: number;
  /** 발급 시각 (unix seconds). */
  iat: number;
  /** "remember me" 로 발급된 쿠키 여부 — auto-renew 시 참고. */
  remember?: boolean;
}

function base64ToBytes(s: string): Uint8Array {
  const binary = atob(s);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return base64ToBytes(padded);
}

let cachedKey: CryptoKey | null = null;

async function getKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;

  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "AUTH_SECRET 가 .env.local 에 설정되어야 합니다 (AUTH_PASSWORD 와 함께).",
    );
  }
  const normalized =
    secret.replace(/=+$/, "") + "==".slice(0, (4 - (secret.length % 4)) % 4);
  const keyBytes = base64ToBytes(normalized);
  if (keyBytes.length !== 32) {
    throw new Error(
      `AUTH_SECRET must decode to 32 bytes (got ${keyBytes.length}). ` +
        `Generate one with: openssl rand -base64 32`,
    );
  }

  cachedKey = await crypto.subtle.importKey(
    "raw",
    keyBytes as unknown as ArrayBuffer,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
  return cachedKey;
}

const IV_LEN = 12;

export async function encryptSession(payload: SessionPayload): Promise<string> {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext),
  );
  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv, 0);
  combined.set(ciphertext, iv.length);
  return bytesToBase64Url(combined);
}

export async function decryptSession(
  token: string,
): Promise<SessionPayload | null> {
  try {
    const key = await getKey();
    const bytes = base64UrlToBytes(token);
    if (bytes.length < IV_LEN + 16) return null;
    const iv = bytes.slice(0, IV_LEN);
    const ciphertext = bytes.slice(IV_LEN);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext,
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as SessionPayload;
  } catch {
    return null;
  }
}

/** 복호화 + 만료 검증. 유효하면 payload, 아니면 null. */
export async function verifySession(
  token: string,
): Promise<SessionPayload | null> {
  const payload = await decryptSession(token);
  if (!payload) return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}
