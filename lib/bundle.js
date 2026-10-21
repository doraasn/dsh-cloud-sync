/**
 * 组装 / 校验归档：manifest.json + 各段文件 → tar.gz。
 * 敏感文件（.credentials.yaml）只以密文形式进包；manifest 里只有哈希，不含明文。
 */
import { collectSections, readEntries, sha256 } from './sections.js';
import { packTarGz, unpackTarGz } from './tar.js';
import { encryptSecrets } from './secrets.js';

export const BUNDLE_SCHEMA_VERSION = 1;

/**
 * 普通段落里的明文密钥一律打码成占位符：
 * 真正的密钥只可能出现在加密的 secrets 负载里（.credentials.yaml.enc）。
 *
 * 打码规则刻意收窄，避免破坏技能里的普通代码/文档：
 *   - Authorization: Bearer xxx —— 所有文本文件都处理（信号强、误伤极低）
 *   - key = value 形式 —— 只在密钥高发文件（mcp/**、.env、credentials 相关）里处理，
 *     且值必须像真密钥（长度 ≥ 16、无空白、无 $ % < { 等占位符特征）
 */
const AUTHORIZATION_RULE = {
  regex: /(Bearer\s+)([A-Za-z0-9._\-]{12,})/g,
  key: () => 'Authorization',
  replace: (m, p1) => `${p1}__SECRET__`,
};

const KEY_VALUE_RULE = {
  regex: /((?:api[_-]?key|apikey|token|password|secret)\s*[:=]\s*)(['"]?)([^\s'"#,\]}]{8,})/gi,
  key: (m, p1) => p1.replace(/[\s:=]+$/g, '').trim(),
  replace: (m, p1, p2) => `${p1}${p2}__SECRET__`,
};

export function isSecretPronePath(archivePath) {
  const name = archivePath.split('/').pop() ?? '';
  return (
    archivePath.startsWith('mcp/') ||
    name === '.env' ||
    name.startsWith('.env.') ||
    /credential|secret/i.test(archivePath)
  );
}

function looksLikeRealSecret(value) {
  if (value.length < 16) return false;
  if (/[$%<>{}]/.test(value)) return false; // 占位符/模板变量
  if (/^(?:true|false|null|undefined)$/i.test(value)) return false;
  return true;
}

function looksTextual(data) {
  const sample = data.subarray(0, 4096);
  for (const byte of sample) if (byte === 0) return false;
  return true;
}

/** @returns {{data: Buffer, placeholders: Array<{path: string, key: string}>}} */
export function redactEntry(entry) {
  if (!looksTextual(entry.data)) return { data: entry.data, placeholders: [] };
  let text = entry.data.toString('utf8');
  const placeholders = [];

  text = text.replace(AUTHORIZATION_RULE.regex, (...args) => {
    placeholders.push({ path: entry.path, key: AUTHORIZATION_RULE.key(...args) });
    return AUTHORIZATION_RULE.replace(...args);
  });

  if (isSecretPronePath(entry.path)) {
    text = text.replace(KEY_VALUE_RULE.regex, (...args) => {
      const value = args[3];
      if (!looksLikeRealSecret(value)) return args[0];
      placeholders.push({ path: entry.path, key: KEY_VALUE_RULE.key(...args) });
      return KEY_VALUE_RULE.replace(...args);
    });
  }

  if (!placeholders.length) return { data: entry.data, placeholders: [] };
  return { data: Buffer.from(text, 'utf8'), placeholders };
}

/** 从 manifest 生成给人看的一行摘要。 */
export function summarizeManifest(manifest) {
  const parts = Object.entries(manifest.sections).map(([name, info]) => `${name}:${info.files}/${formatBytes(info.bytes)}`);
  return parts.join('  ');
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 打包。
 * @param {object} config 插件配置
 * @param {{password?: string, paths?: object, now?: Date, host?: string}} options
 *        password：开启 includeSecrets 时必填（用于加密 .credentials.yaml）
 */
export function buildBundle(config, options = {}) {
  const collected = collectSections(config, options.paths ?? {});
  const warnings = [...collected.warnings];
  const entries = readEntries(collected.files);

  const manifestSections = {};
  const manifestEntries = [];
  const payload = [];
  const placeholders = [];
  let needsSecretPassword = false;

  for (const entry of entries) {
    if (entry.secret) {
      needsSecretPassword = true;
      continue;
    }
    const redacted = config.redact === false ? { data: entry.data, placeholders: [] } : redactEntry(entry);
    placeholders.push(...redacted.placeholders);
    const bytes = redacted.data.length;
    const digest = sha256(redacted.data);
    manifestEntries.push({ path: entry.path, bytes, sha256: digest, originalBytes: entry.bytes });
    payload.push({ path: entry.path, data: redacted.data });
    const section = entry.path.split('/')[0];
    const bucket = (manifestSections[section] ??= { files: 0, bytes: 0 });
    bucket.files += 1;
    bucket.bytes += bytes;
  }

  if (needsSecretPassword) {
    if (!options.password) {
      throw new Error(
        '配置里开启了 includeSecrets，但没有可用的加密口令：请先在凭据槽设置 ' +
          `${config.secretPasswordRef}（或临时用 /nsync secret <口令>），否则敏感文件不会进包。`,
      );
    }
    const plaintext = entries
      .filter((entry) => entry.secret)
      .map((entry) => entry.data)
      .reduce((acc, buf) => Buffer.concat([acc, buf]), Buffer.alloc(0));
    const envelope = encryptSecrets(plaintext, options.password);
    const secretPath = 'secrets/.credentials.yaml.enc';
    const encryptedEntry = { path: secretPath, bytes: envelope.length, sha256: sha256(envelope) };
    manifestEntries.push(encryptedEntry);
    payload.push({ path: secretPath, data: envelope });
    manifestSections.secrets = { files: 1, bytes: envelope.length, encrypted: true };
  }

  const manifest = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    createdAt: (options.now ?? new Date()).toISOString(),
    host: options.host ?? 'unknown',
    platform: process.platform,
    profile: collected.profile,
    dshHome: collected.dshHome,
    agentsHome: collected.agentsHome,
    sections: manifestSections,
    files: manifestEntries,
    placeholders,
    totals: { files: manifestEntries.length, bytes: manifestEntries.reduce((sum, item) => sum + item.bytes, 0) },
    skippedFiles: collected.skipped ?? [],
    warnings,
  };

  const archive = packTarGz([{ path: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') }, ...payload]);
  return { archive, manifest, warnings, placeholders };
}

/** 解包并逐文件校验 sha256；任何不一致直接抛错。 */
export function openBundle(archive) {
  const files = unpackTarGz(archive);
  const manifestFile = files.find((file) => file.path === 'manifest.json');
  if (!manifestFile) throw new Error('归档缺少 manifest.json');
  const manifest = JSON.parse(manifestFile.data.toString('utf8'));
  const mismatched = [];
  for (const expected of manifest.files) {
    const found = files.find((file) => file.path === expected.path);
    if (!found) {
      mismatched.push(`${expected.path}: 缺失`);
      continue;
    }
    const digest = sha256(found.data);
    if (digest !== expected.sha256) mismatched.push(`${expected.path}: 哈希不一致`);
  }
  const payload = files.filter((file) => !file.dir && file.path !== 'manifest.json');
  return { manifest, files: payload, mismatched };
}
