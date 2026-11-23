import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { getServerEnv } from "@/lib/env";

/**
 * AES-256-GCM envelope encryption for third-party secrets we must keep in
 * Postgres (SMTP passwords per sender account).
 *
 * Format: `v1:<iv-b64>:<authTag-b64>:<ciphertext-b64>`
 * Key:    APP_ENCRYPTION_KEY — 64 hex chars (`openssl rand -hex 32`) or any
 *         string, which we stretch with SHA-256.
 *
 * Rotate by keeping the old key in APP_ENCRYPTION_KEY_PREVIOUS and re-saving.
 */

const PREFIX = "v1";

function key(): Buffer {
  const raw = getServerEnv().APP_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "APP_ENCRYPTION_KEY is not set. Generate one with `openssl rand -hex 32` — it is required to store SMTP passwords.",
    );
  }
  // Accept hex(32 bytes) directly, otherwise stretch with SHA-256.
  return /^[0-9a-f]{64}$/i.test(raw)
    ? Buffer.from(raw, "hex")
    : createHash("sha256").update(raw, "utf8").digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    PREFIX,
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

export function decryptSecret(envelope: string): string {
  const parts = envelope.split(":");
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new Error("Malformed secret envelope");
  }
  const [, ivB64, tagB64, dataB64] = parts as [
    typeof PREFIX,
    string,
    string,
    string,
  ];
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** Never let a secret leak into an API response or log line. */
export function maskSecret(value: string | null | undefined) {
  if (!value) return null;
  return `••••${value.slice(-2)}`;
}
