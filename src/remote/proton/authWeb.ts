/**
 * Browser-based login via session fork. Port of the account module's `authWeb.ts`.
 *
 * The client creates a fork request, shows the user a sign-in URL that carries
 * a random AES key, and polls until the user has approved in the browser.
 * Proton's page handles password entry and any second factor; the key
 * password comes back encrypted to our key.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const DEFAULT_PROTON_ACCOUNT_URL = 'account.proton.me';
const FORK_AAD = Buffer.from('fork', 'utf8');
const GCM_NONCE_LENGTH = 12;
const GCM_TAG_LENGTH = 16;

export const FORK_POLL_INTERVAL_MS = 5000;
export const FORK_INITIAL_DELAY_MS = 5000;
export const FORK_MAX_POLL_TIME_MS = 10 * 60 * 1000;

export function generateSignInUrl(
  authClientId: string,
  userCode: string,
  accountUrl: string = DEFAULT_PROTON_ACCOUNT_URL,
  encryptionKey: Buffer = randomBytes(32),
): { encryptionKey: Buffer; signInUrl: string } {
  const accountUrlWithProtocol = /^https?:\/\//.test(accountUrl) ? accountUrl : `https://${accountUrl}`;
  const payload = `0:${userCode}:${encryptionKey.toString('base64')}:${authClientId}`;
  const signInUrl = `${accountUrlWithProtocol}/desktop/login?app=drive&pv=3#payload=${encodeURIComponent(payload)}`;
  return { encryptionKey, signInUrl };
}

export function parseUserKeyPassword(encryptionKey: Buffer, encryptedPayload: string): string {
  const json = decryptForkPayload(encryptedPayload, encryptionKey);
  const payload = JSON.parse(json) as { type?: string; keyPassword?: unknown };
  if (typeof payload.keyPassword !== 'string' || payload.keyPassword === '') {
    throw new Error('Failed to deserialize the fork payload');
  }
  return payload.keyPassword;
}

function decryptForkPayload(encodedPayload: string, encryptionKey: Buffer): string {
  const blob = Buffer.from(encodedPayload, 'base64');
  if (blob.length < GCM_NONCE_LENGTH + GCM_TAG_LENGTH) throw new Error('Invalid fork payload blob length');
  const nonce = blob.subarray(0, GCM_NONCE_LENGTH);
  const tag = blob.subarray(blob.length - GCM_TAG_LENGTH);
  const ciphertext = blob.subarray(GCM_NONCE_LENGTH, blob.length - GCM_TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, nonce);
  decipher.setAuthTag(tag);
  decipher.setAAD(FORK_AAD);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** Inverse of decryptForkPayload; used by tests to simulate the server side. */
export function encryptForkPayload(payloadJson: string, encryptionKey: Buffer): string {
  const nonce = randomBytes(GCM_NONCE_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce);
  cipher.setAAD(FORK_AAD);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(payloadJson, 'utf8')), cipher.final()]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64');
}
