import crypto from 'crypto';

/**
 * AES-256-GCM helper for encrypting secrets at rest (database connection
 * passwords). Unlike the existing JiraIntegration.apiToken column, which is
 * stored in plaintext, DB connection credentials are always encrypted here.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function getKey(): Buffer {
  const keyStr = process.env.DB_CREDENTIALS_ENCRYPTION_KEY;
  if (!keyStr) {
    throw new Error('DB_CREDENTIALS_ENCRYPTION_KEY is not set — required to store/read database connection credentials.');
  }
  // Accept either a 32-byte hex/base64 string or an arbitrary passphrase (hashed down to 32 bytes).
  if (keyStr.length === 64 && /^[0-9a-fA-F]+$/.test(keyStr)) return Buffer.from(keyStr, 'hex');
  return crypto.createHash('sha256').update(keyStr).digest();
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

export function decrypt(ciphertext: string): string {
  const key = getKey();
  const raw = Buffer.from(ciphertext, 'base64');
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + 16);
  const encrypted = raw.subarray(IV_LENGTH + 16);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
