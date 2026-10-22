/**
 * 归档内敏感负载的加密：scrypt 派生 + AES-256-GCM。
 * 口令不进归档、不进日志；盐与 IV 每次随机。
 */
import crypto from 'node:crypto';

// N=2^15, r=8 需要约 33.5 MB 内存，超过 Node 默认 maxmem(32MB)，必须显式放宽
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

export function encryptSecrets(plaintext, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.from(
    JSON.stringify({
      v: 1,
      kdf: { name: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('base64') },
      cipher: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: data.toString('base64'),
    }),
    'utf8',
  );
}

export function decryptSecrets(envelope, password) {
  const parsed = JSON.parse(envelope.toString('utf8'));
  const salt = Buffer.from(parsed.kdf.salt, 'base64');
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: parsed.kdf.N,
    r: parsed.kdf.r,
    p: parsed.kdf.p,
    maxmem: SCRYPT.maxmem,
  });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(parsed.data, 'base64')), decipher.final()]);
}

// —— 行内密钥的加密占位符：__ENC:<base64>__ ——
// 与整包加密同样的算法，但每个值独立加密、盐与 IV 各自随机，
// 这样同一个口令可以逐处解密，且不暴露明文。

export const ENCRYPTED_TOKEN = /__ENC:([A-Za-z0-9+/=]+)__/g;

function encryptValue(value, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(Buffer.from(value, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, tag, data]).toString('base64');
}

function decryptValue(payload, password) {
  const raw = Buffer.from(payload, 'base64');
  const salt = raw.subarray(0, 16);
  const iv = raw.subarray(16, 28);
  const tag = raw.subarray(28, 44);
  const data = raw.subarray(44);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** 把单个明文密钥换成 `__ENC:<base64>__` 令牌。 */
export function sealInlineSecret(value, password) {
  return `__ENC:${encryptValue(value, password)}__`;
}

/**
 * 把文本里所有 `__ENC:...__` 解密回明文。
 * 口令不对时逐个跳过（保留令牌），返回失败计数。
 * @returns {{text: string, restored: number, failed: number}}
 */
export function openInlineSecrets(text, password) {
  let restored = 0;
  let failed = 0;
  const next = text.replace(ENCRYPTED_TOKEN, (match, payload) => {
    try {
      const value = decryptValue(payload, password);
      restored += 1;
      return value;
    } catch {
      failed += 1;
      return match;
    }
  });
  return { text: next, restored, failed };
}
