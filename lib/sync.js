/**
 * 同步编排：打包、上传、保留策略清理；以及状态/列表查询。
 * 网络动作只由显式命令或自动同步的定时器触发，不在渲染路径里发生。
 */
import os from 'node:os';
import { computeFingerprint, describeAutoSync } from './autosync.js';
import { WebDavClient } from './webdav.js';
import { buildBundle, formatBytes, openBundle, summarizeManifest } from './bundle.js';
import { dailyScopeConfig, hostOf, loadConfig, loadState, resolvePassword, saveState } from './config.js';
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

/** 本月键（本地时区的自然月 YYYY-MM），与坚果云网页端的流量口径一致。 */
export function currentMonthKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

export function snapshotFileName(date = new Date(), { full = false } = {}) {
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${SNAPSHOT_PREFIX}${stamp}${full ? '-full' : ''}${SNAPSHOT_SUFFIX}`;
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
  // 口令与 host 绑定：改过 WebDAV 地址（credentialHost 被清空或不一致）就拒绝发口令，
  // 否则一次 config 改写就能把 Basic 凭据送到任意服务器。
  const host = hostOf(config.baseUrl);
  if (!config.credentialHost) {
    throw new Error(
      `WebDAV 地址已变更（当前 ${host}）：请重新执行 /csync secret <应用密码> 绑定新地址后再同步。`,
    );
  }
  if (config.credentialHost !== host) {
    throw new Error(
      `WebDAV 口令属于 ${config.credentialHost}，与当前地址 ${host} 不一致：请重新执行 /csync secret <应用密码>。`,
    );
  }
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

/** 只保留最新 keep 份（连同 .sha256 边车）；全量快照额外保留最新 keepFull 份。 */
export async function applyRetention(client, config, snapshots) {
  const keep = Math.max(1, Number(config.keep) || 1);
  const keepFull = Math.max(0, Number(config.keepFull) || 0);
  const survivors = new Set(snapshots.slice(0, keep).map((item) => item.name));
  if (keepFull > 0) {
    const fulls = snapshots.filter((item) => item.name.includes('-full')).slice(0, keepFull);
    for (const item of fulls) survivors.add(item.name);
  }
  const removed = [];
  for (const stale of snapshots) {
    if (survivors.has(stale.name)) continue;
    await client.remove(`${config.remoteDir}/${stale.name}`);
    await client.remove(`${config.remoteDir}/${stale.name}.sha256`);
    removed.push(stale.name);
  }
  return removed;
}

/** 打包并上传一份快照。 */
export async function pushSnapshot(ctx, { dryRun = false, scope = 'full' } = {}) {
  const current = loadConfig();
  // 日常档只包含配置类段落，全量档包含全部启用段落
  const config = scope === 'daily' ? dailyScopeConfig(current) : current;
  const credentials = getService(ctx, 'credentials');
  // 内联密钥的加密口令：优先用独立槽（可选覆盖），没有就用 WebDAV 应用密码。
  // 与「是否打包 .credentials.yaml」解耦，也不必再在设置页单独填口令。
  // 注意 password 是 createClient 的局部变量，这里必须自己解析一次；
  // 以前直接引用它，没有独立口令时 push 会抛出 ReferenceError。
  const secretPassword =
    (await resolvePassword(credentials, config.secretPasswordRef)) ??
    (await resolvePassword(credentials, config.passwordRef));
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
    const name = snapshotFileName(new Date(), { full: scope !== 'daily' });
    const digest = sha256(archive);
    setPhase('uploading', `正在上传 ${name}（${formatBytes(archive.length)}）…`);
    await client.put(`${config.remoteDir}/${name}`, archive);
    await client.put(`${config.remoteDir}/${name}.sha256`, Buffer.from(`${digest}  ${name}\n`, 'utf8'));

    // 累计本月上传流量：坚果云免费版按月限 1GB，重传同样计费
    const month = currentMonthKey();
    const previousUsage = loadState().usage?.month === month ? Number(loadState().usage.bytes) || 0 : 0;
    const usage = { month, bytes: previousUsage + archive.length, updatedAt: new Date().toISOString() };

    setPhase('retention', '正在应用保留策略…');
    const snapshots = await remoteSnapshots(client, config);
    const removed = await applyRetention(client, config, snapshots);
    saveState({
      lastPush: { name, bytes: archive.length, sha256: digest, at: new Date().toISOString() },
      usage,
      // 手动上传也刷新指纹，避免自动同步紧接着再传一份相同内容
      ...(scope === 'daily'
        ? { lastFingerprint: computeFingerprint(config) }
        : { lastFingerprint: computeFingerprint(config), lastFullPushAt: new Date().toISOString() }),
    });

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
  lines.push(`   自动同步 ${describeAutoSync(config)}`);
  const usage = loadState().usage;
  const month = currentMonthKey();
  if (usage && usage.month === month) {
    lines.push(`   本月已上传 ${formatBytes(Number(usage.bytes) || 0)}（坚果云免费版每月 1 GB）`);
  } else {
    lines.push('   本月尚未上传（坚果云免费版每月 1 GB）');
  }

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
