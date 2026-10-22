/**
 * 同步编排：打包、上传、保留策略清理；以及状态/列表查询。
 * 所有网络动作都在显式命令下发生，不做后台隐式上传。
 */
import os from 'node:os';
import { WebDavClient } from './webdav.js';
import { buildBundle, formatBytes, openBundle, summarizeManifest } from './bundle.js';
import { loadConfig, loadState, resolvePassword, saveState } from './config.js';
import { sha256 } from './sections.js';

export const SNAPSHOT_PREFIX = 'dsh-sync-';
export const SNAPSHOT_SUFFIX = '.tar.gz';

/**
 * 进度快照：设置页在动作进行中轮询 /api/state 读取它。
 * 只保留最近一次动作的状态，避免无限增长。
 */
export const progress = {
  phase: 'idle', // idle | collecting | packing | uploading | retention | done | error
  message: '',
  startedAt: null,
  updatedAt: null,
  bytes: 0,
  files: 0,
};

function setPhase(phase, message = '', extra = {}) {
  progress.phase = phase;
  progress.message = message;
  progress.updatedAt = new Date().toISOString();
  progress.startedAt ??= progress.updatedAt;
  if (extra.bytes !== undefined) progress.bytes = extra.bytes;
  if (extra.files !== undefined) progress.files = extra.files;
}

export function resetProgress() {
  progress.phase = 'idle';
  progress.message = '';
  progress.startedAt = null;
  progress.updatedAt = null;
  progress.bytes = 0;
  progress.files = 0;
}

export function snapshotFileName(date = new Date()) {
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${SNAPSHOT_PREFIX}${stamp}${SNAPSHOT_SUFFIX}`;
}

export function isSnapshotName(name) {
  return name.startsWith(SNAPSHOT_PREFIX) && name.endsWith(SNAPSHOT_SUFFIX);
}

export function getService(ctx, name) {
  try {
    return ctx.get(name);
  } catch {
    return undefined;
  }
}

export async function createClient(ctx, config) {
  const credentials = getService(ctx, 'credentials');
  const password = await resolvePassword(credentials, config.passwordRef);
  if (!password) {
    throw new Error(
      `没有拿到 WebDAV 应用密码：请先执行 /csync secret <应用密码>（写入凭据槽 ${config.passwordRef}），` +
        `或设置环境变量 ${config.passwordRef}。`,
    );
  }
  if (!config.username) throw new Error('还没有配置 WebDAV 账号：/csync config username 你的用户名');
  return new WebDavClient({ baseUrl: config.baseUrl, username: config.username, password, logger: getService(ctx, 'logger') });
}

/** 列远端快照，新的在前。 */
export async function remoteSnapshots(client, config) {
  const entries = await client.list(config.remoteDir);
  if (!entries) return [];
  return entries
    .filter((entry) => !entry.dir && isSnapshotName(entry.name))
    .map((entry) => ({ name: entry.name, bytes: entry.size, lastModified: entry.lastModified }))
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

/** 只保留最新 keep 份（连同 .sha256 边车）。 */
export async function applyRetention(client, config, snapshots) {
  const keep = Math.max(1, Number(config.keep) || 1);
  const removed = [];
  for (const stale of snapshots.slice(keep)) {
    await client.remove(`${config.remoteDir}/${stale.name}`);
    await client.remove(`${config.remoteDir}/${stale.name}.sha256`);
    removed.push(stale.name);
  }
  return removed;
}

/** 打包并上传一份快照。 */
export async function pushSnapshot(ctx, { dryRun = false } = {}) {
  const config = loadConfig();
  const credentials = getService(ctx, 'credentials');
  const secretPassword = config.includeSecrets ? await resolvePassword(credentials, config.secretPasswordRef) : null;
  resetProgress();
  const startedMs = Date.now();

  try {
    setPhase('collecting', '正在收集文件…');
    const bundle = buildBundle(config, { password: secretPassword, host: os.hostname() });
    const { archive, manifest } = bundle;
    setPhase('packing', '正在校验归档…', { bytes: archive.length, files: manifest.totals.files });

    const lines = [];
    lines.push(`归档 ${formatBytes(archive.length)}｜${manifest.totals.files} 个文件`);
    lines.push(`   段落 ${summarizeManifest(manifest)}`);
    if (bundle.placeholders.length) {
    const sealed = bundle.placeholders.filter((item) => item.encrypted).length;
    const masked = bundle.placeholders.length - sealed;
    if (sealed) lines.push(`   已加密 ${sealed} 处明文密钥（恢复时用同一口令还原）`);
    if (masked) lines.push(`   已打码 ${masked} 处明文密钥（未配置口令，恢复后需重填）`);
  }
    const skippedFiles = manifest.skippedFiles ?? [];
    if (skippedFiles.length) {
      lines.push(`   已跳过 ${skippedFiles.length} 个文件（共 ${formatBytes(skippedFiles.reduce((s, f) => s + f.bytes, 0))}）`);
    }

    const data = {
      action: 'push',
      dryRun,
      snapshot: null,
      totals: manifest.totals,
      sections: manifest.sections,
      placeholders: bundle.placeholders,
      skipped: skippedFiles,
      durationMs: 0,
      archiveBytes: archive.length,
    };

    if (dryRun) {
      resetProgress();
      data.durationMs = Date.now() - startedMs;
      lines.push('预演完成，未上传任何内容。');
      return { kind: 'success', text: lines.join('\n'), data, manifest, archive };
    }

    const client = await createClient(ctx, config);
    await client.ensureDir(config.remoteDir);
    const name = snapshotFileName();
    const digest = sha256(archive);
    setPhase('uploading', `正在上传 ${name}（${formatBytes(archive.length)}）…`);
    await client.put(`${config.remoteDir}/${name}`, archive);
    await client.put(`${config.remoteDir}/${name}.sha256`, Buffer.from(`${digest}  ${name}\n`, 'utf8'));

    setPhase('retention', '正在应用保留策略…');
    const snapshots = await remoteSnapshots(client, config);
    const removed = await applyRetention(client, config, snapshots);
    saveState({ lastPush: { name, bytes: archive.length, sha256: digest, at: new Date().toISOString() } });

    data.durationMs = Date.now() - startedMs;
    data.snapshot = { name, bytes: archive.length, sha256: digest, at: new Date().toISOString() };
    data.removed = removed;
    data.remoteCount = snapshots.length;
    setPhase('done', `完成：${name}`, { bytes: archive.length });

    lines.push(`已上传 ${name}（${formatBytes(archive.length)}）到 ${config.remoteDir}/`);
    if (removed.length) lines.push(`按保留策略删除旧快照 ${removed.length} 份：${removed.join(', ')}`);
    lines.push(`   远端现有 ${snapshots.length} 份，sha256 ${digest.slice(0, 16)}…`);
    return { kind: 'success', text: lines.join('\n'), data, manifest, snapshots };
  } catch (err) {
    setPhase('error', err?.message ?? String(err));
    throw err;
  }
}

/** 状态总览：配置 / 凭据 / 远端 / 上次推送。 */
export async function statusReport(ctx) {
  const config = loadConfig();
  const state = loadState();
  const credentials = getService(ctx, 'credentials');
  const lines = [];
  lines.push('云同步 · 状态');
  lines.push(`   端点 ${config.baseUrl}｜账号 ${config.username || '(未配置)'}｜远端目录 ${config.remoteDir}`);
  lines.push(`   段落 ${config.sections.join(', ')}｜保留 ${config.keep} 份｜密钥 ${config.includeSecrets ? '打包（加密）' : '不打包'}｜打码 ${config.redact === false ? '关闭' : '开启'}`);
  lines.push(`   单文件上限 ${config.maxFileBytes ? formatBytes(config.maxFileBytes) : '不限'}｜自动同步 ${config.autoSyncHours ? config.autoSyncHours + ' 小时' : '关闭'}`);

  if (credentials?.describe) {
    try {
      const described = await credentials.describe(config.passwordRef);
      lines.push(`   口令槽 ${config.passwordRef}：${described?.configured ? '已配置' : '未配置'}`);
    } catch {
      lines.push(`   口令槽 ${config.passwordRef}：无法查询`);
    }
  }
  lines.push(state.lastPush ? `   上次推送 ${state.lastPush.name}（${formatBytes(state.lastPush.bytes)}，${state.lastPush.at}）` : '   上次推送：无记录');

  try {
    const client = await createClient(ctx, config);
    const snapshots = await remoteSnapshots(client, config);
    lines.push(`   远端快照 ${snapshots.length} 份${snapshots.length ? `：${snapshots.slice(0, 3).map((s) => `${s.name}(${formatBytes(s.bytes)})`).join('、')}` : ''}`);
  } catch (err) {
    lines.push(`   远端不可用：${err.message}`);
  }
  return { kind: 'success', text: lines.join('\n') };
}

export function listReport(snapshots) {
  if (!snapshots.length) return '远端还没有快照。先跑一次 /csync push。';
  const lines = ['远端快照（按时间倒序）'];
  for (const item of snapshots) {
    lines.push(`   ${item.name}  ${formatBytes(item.bytes)}  ${item.lastModified ?? ''}`);
  }
  return lines.join('\n');
}

/** 取回一份快照（默认最新），并用边车 .sha256 校验。 */
export async function fetchSnapshot(ctx, nameOrLatest) {
  const config = loadConfig();
  const client = await createClient(ctx, config);
  const snapshots = await remoteSnapshots(client, config);
  if (!snapshots.length) throw new Error(`远端 ${config.remoteDir}/ 里没有快照`);
  const wanted =
    !nameOrLatest || nameOrLatest === 'latest'
      ? snapshots[0]
      : snapshots.find((item) => item.name === nameOrLatest || item.name.startsWith(nameOrLatest));
  if (!wanted) throw new Error(`找不到快照 ${nameOrLatest}；可用：${snapshots.map((s) => s.name).join(', ')}`);

  const archive = await client.get(`${config.remoteDir}/${wanted.name}`);
  const digest = sha256(archive);
  let sidecarNote = '';
  try {
    const sidecar = (await client.get(`${config.remoteDir}/${wanted.name}.sha256`)).toString('utf8').trim();
    const expected = sidecar.split(/\s+/)[0];
    sidecarNote = expected === digest ? '，边车校验通过' : `，边车不一致（远端 ${expected.slice(0, 16)}…）`;
  } catch {
    sidecarNote = '，无 .sha256 边车';
  }
  return { config, client, snapshot: wanted, archive, digest, sidecarNote };
}

export { openBundle };
