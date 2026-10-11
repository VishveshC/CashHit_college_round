import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { encodeAbiParameters, keccak256, pad, stringToHex, toHex } from 'viem';

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function randomBytes32(): string {
  return `0x${randomBytes(32).toString('hex')}`;
}

export function safeEqualHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export function privateCommitment(tag: string, text: string, salt: string): string {
  const tagBytes = pad(stringToHex(tag), { size: 32, dir: 'right' });
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }],
    [tagBytes, keccak256(stringToHex(text)), salt as `0x${string}`],
  ));
}

export type Ciphertext = { ciphertext: Buffer; iv: Buffer; authTag: Buffer };

export function encryptBytes(masterKey: Buffer, plaintext: Buffer, context: string): Ciphertext {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

export function decryptBytes(masterKey: Buffer, encrypted: Ciphertext, context: string): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', masterKey, encrypted.iv);
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(encrypted.authTag);
  return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]);
}

export function encryptJson(masterKey: Buffer, value: unknown, context: string): Ciphertext {
  return encryptBytes(masterKey, Buffer.from(JSON.stringify(value), 'utf8'), context);
}

export function decryptJson<T>(masterKey: Buffer, encrypted: Ciphertext, context: string): T {
  return JSON.parse(decryptBytes(masterKey, encrypted, context).toString('utf8')) as T;
}

export function hmacToken(secret: Buffer, purpose: string, value: string): string {
  return createHmac('sha256', secret).update(`${purpose}\0${value}`).digest('base64url');
}

export function signPayload(secret: Buffer, payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyPayload<T>(secret: Buffer, token: string): T | null {
  const parts = token.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return null;
  const expected = createHmac('sha256', secret).update(parts[0]).digest();
  let actual: Buffer;
  try { actual = Buffer.from(parts[1], 'base64url'); } catch { return null; }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try { return JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as T; } catch { return null; }
}

export function hashBytes(bytes: Buffer): string {
  return keccak256(toHex(bytes));
}
