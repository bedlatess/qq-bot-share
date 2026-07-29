import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function randomId(prefix = ''): string {
  return `${prefix}${randomBytes(12).toString('hex')}`;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function hashPassword(password: string, salt = randomBytes(16).toString('hex')) {
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return { salt, hash: key.toString('hex') };
}

export async function verifyPassword(password: string, salt: string, expectedHex: string) {
  const actual = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function encryptionKey(masterKey: string): Buffer {
  return createHash('sha256').update(masterKey).digest();
}

export function encryptSecret(value: string, masterKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(masterKey), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptSecret(payload: string, masterKey: string): string {
  const [version, ivPart, tagPart, bodyPart] = payload.split('.');
  if (version !== 'v1' || !ivPart || !tagPart || !bodyPart) throw new Error('Invalid encrypted secret');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(masterKey), Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(bodyPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

const cardAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function createActivationCode(prefix = 'PUFF'): string {
  const groups = Array.from({ length: 4 }, () =>
    Array.from({ length: 5 }, () => cardAlphabet[randomBytes(1)[0]! % cardAlphabet.length]).join(''),
  );
  return `${prefix}-${groups.join('-')}`;
}

export function maskSecret(value: string): string {
  if (value.length < 9) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}${'*'.repeat(Math.min(12, value.length - 8))}${value.slice(-4)}`;
}
