/**
 * 子命令实现：命令层与设置页 HTTP API 共用同一份逻辑，避免两套行为漂移。
 * 输入是拆分后的 token；返回 { kind, text, data? }。
 */
import os from 'node:os';
import { hostOf, loadConfig, loadState, resolvePassword, saveConfig, saveState } from './config.js';
import {
  applyRetention,
  createClient,
  fetchSnapshot,
  getService,
  listReport,
  progress,
  pushSnapshot,
  remoteSnapshots,
  statusReport,
} from './sync.js';
import { applyRestore, formatPlan, planRestore } from './restore.js';

export const USAGE = [
  '用法：/csync <子命令>',
  '  status                状态总览（默认）',
  '  config [键] [值]      查看或修改配置（值支持 JSON）',
  '  secret <应用密码>     写入 DSH 凭据槽（不落配置文件）',
  '  push [--dry-run]      打包并上传一份快照',
  '  list                  列远端快照',
  '  diff [快照名]         下载并预演恢复计划（零写入）',
  '  pull [快照名] --yes   真正落盘恢复（默认只预演；先自动备份、失败回滚）',
  '  delete <快照名>       删除指定远端快照（含校验边车）',
  '  prune                 按保留份数清理远端',
].join('\n');

export function parseConfigValue(raw) {
  const text = String(raw).trim();
  if (text === '' || text === '""') return '';
  if (/^[[{"]/.test(text) || /^(true|false|null)$/i.test(text) || /^-?\d+(\.\d+)?$/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      return raw;
    }
  }
  return raw;
}

const clampInt = (value, min, max, fallback) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
};

/**
 * HTTP / 命令入口能写哪些配置键。
 *
 * 以前是「任意键直接合并」：一个跨站 POST 就能把 baseUrl 指到攻击者服务器，
 * 之后每次轮询都会把 WebDAV 口令（Basic）发过去。这里改成白名单 + 逐键校验，
 * 未列出的键一律拒绝。
 */
const WRITABLE_CONFIG = new Set([
  'baseUrl',
  'username',
  'remoteDir',
  'sections',
  'exclude',
  'includeSecrets',
  'excludeBinaries',
  'autoSyncMode',
  'autoSyncMinutes',
  'autoSyncDebounceSeconds',
  'fullSyncMinutes',
  'keep',
]);

export function validateConfigPatch(key, value) {
  if (!WRITABLE_CONFIG.has(key)) throw new Error(`不允许修改配置键：${key}（可写：${[...WRITABLE_CONFIG].join(', ')}）`);
  switch (key) {
    case 'baseUrl': {
      const text = String(value ?? '').trim();
      let url;
      try {
        url = new URL(text);
      } catch {
        throw new Error('baseUrl 不是合法 URL');
      }
      if (!/^https?:$/.test(url.protocol)) throw new Error('baseUrl 只支持 http(s)');
      return text;
    }
    case 'username':
      return String(value ?? '').trim().slice(0, 200);
    case 'remoteDir': {
      const text = String(value ?? '').trim().replace(/^\/+|\/+$/g, '');
      const segments = text.split('/');
      if (!text || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
        throw new Error('remoteDir 不合法（不能为空、不能含 . 或 ..）');
      }
      return text;
    }
    case 'sections': {
      const list = Array.isArray(value) ? value : String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
      if (list.length === 0) throw new Error('sections 不能为空');
      return list.map((item) => String(item)).slice(0, 64);
    }
    case 'exclude':
      return (Array.isArray(value) ? value : [value]).map((item) => String(item)).slice(0, 200);
    case 'includeSecrets':
    case 'excludeBinaries':
      return value === true || value === 'true';
    case 'autoSyncMode': {
      const text = String(value ?? '');
      if (!['off', 'interval', 'watch'].includes(text)) throw new Error('autoSyncMode 只能是 off / interval / watch');
      return text;
    }
    case 'autoSyncMinutes':
      return clampInt(value, 1, 1440, 60);
    case 'autoSyncDebounceSeconds':
      return clampInt(value, 0, 3600, 90);
    case 'fullSyncMinutes':
      return clampInt(value, 0, 10080, 10080);
    case 'keep':
      return clampInt(value, 1, 50, 5);
    default:
      throw new Error(`未知配置键：${key}`);
  }
}

export function formatConfig(config) {
  const lines = ['云同步 · 配置'];
  for (const [key, value] of Object.entries(config)) lines.push(`   ${key} = ${JSON.stringify(value)}`);
  lines.push('   （口令不在此处，存放于 DSH 凭据槽）');
  return lines.join('\n');
}

/** 供设置页读取的脱敏状态。 */
export async function stateSnapshot(ctx) {
  const config = loadConfig();
  const credentials = getService(ctx, 'credentials');
  let credentialConfigured = false;
  let secretPasswordConfigured = false;
  if (credentials?.describe) {
    try {
      credentialConfigured = Boolean((await credentials.describe(config.passwordRef))?.configured);
    } catch {
      credentialConfigured = false;
    }
    try {
      secretPasswordConfigured = Boolean((await credentials.describe(config.secretPasswordRef))?.configured);
    } catch {
      secretPasswordConfigured = false;
    }
  }
  let snapshots = [];
  let remoteError = null;
  try {
    const client = await createClient(ctx, config);
    snapshots = await remoteSnapshots(client, config);
  } catch (err) {
    remoteError = err.message;
  }
  // 凭据槽名对设置页没有用：下发给客户端只会多一个「去哪儿覆盖 key」的线索。
  const { passwordRef: _passwordRef, secretPasswordRef: _secretPasswordRef, ...publicConfig } = config;
  return {
    config: publicConfig,
    credentialConfigured,
    secretPasswordConfigured,
    snapshots,
    remoteError,
    state: loadState(),
    progress: { ...progress },
    usage: loadState().usage ?? null,
    defaults: { host: os.hostname(), platform: process.platform },
  };
}

export async function runSubcommand(ctx, tokens) {
  const args = [...tokens];
  const sub = (args.shift() ?? 'status').toLowerCase();

  switch (sub) {
    case 'status':
      return statusReport(ctx);

    case 'state':
      return { kind: 'success', text: 'ok', data: await stateSnapshot(ctx) };

    case 'config': {
      const [key, ...rest] = args;
      const current = loadConfig();
      if (!key) return { kind: 'success', text: formatConfig(current), data: current };
      if (!rest.length) {
        if (!(key in current)) return { kind: 'error', text: `未知配置键：${key}\n${formatConfig(current)}` };
        return { kind: 'success', text: `${key} = ${JSON.stringify(current[key])}` };
      }
      const value = parseConfigValue(rest.join(' '));
      let patch;
      try {
        patch = { [key]: validateConfigPatch(key, value) };
      } catch (err) {
        return { kind: 'error', text: String(err?.message ?? err) };
      }
      // 换 host 等于换了收口令的人：清掉绑定，强制重新 /csync secret。
      if (key === 'baseUrl' && hostOf(current.baseUrl) !== hostOf(patch.baseUrl)) {
        patch.credentialHost = '';
      }
      const next = saveConfig(patch);
      return { kind: 'success', text: `已更新 ${key} = ${JSON.stringify(next[key])}`, data: next };
    }

    case 'secret': {
      const secret = args.join(' ');
      if (!secret) return { kind: 'error', text: '用法：/csync secret <WebDAV 应用密码>' };
      const credentials = getService(ctx, 'credentials');
      if (!credentials?.set) return { kind: 'error', text: '当前宿主没有 credentials 服务，无法写入凭据槽。' };
      const config = loadConfig();
      try {
        await credentials.set(config.passwordRef, secret);
        // 口令与当前 host 绑定：之后改地址必须重新设置，不能自动跟过去。
        saveConfig({ credentialHost: hostOf(config.baseUrl) });
        return { kind: 'success', text: `已写入凭据槽 ${config.passwordRef}（绑定 ${hostOf(config.baseUrl)}）` };
      } catch (err) {
        return { kind: 'error', text: `写入凭据失败：${err.message}` };
      }
    }

    case 'secret-ref': {
      // 写入任意凭据槽（设置页用：加密口令 CLOUD_SYNC_SECRET_PASSWORD）
      const [ref, ...rest] = args;
      const value = rest.join(' ');
      if (!ref || !value) return { kind: 'error', text: '用法：/csync secret-ref <凭据槽名> <值>' };
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) return { kind: 'error', text: `凭据槽名不合法：${ref}` };
      // 只允许写本插件自己的加密口令槽：放开就等于「覆盖宿主/其它插件的模型 key」。
      const allowed = new Set([loadConfig().secretPasswordRef, loadConfig().passwordRef]);
      if (!allowed.has(ref)) {
        return { kind: 'error', text: `拒绝写入 ${ref}：只允许本插件的口令槽（${[...allowed].join(' / ')}）` };
      }
      const credentials = getService(ctx, 'credentials');
      if (!credentials?.set) return { kind: 'error', text: '当前宿主没有 credentials 服务，无法写入凭据槽。' };
      try {
        await credentials.set(ref, value);
        return { kind: 'success', text: `已写入凭据槽 ${ref}` };
      } catch (err) {
        return { kind: 'error', text: `写入凭据失败：${err.message}` };
      }
    }

    case 'push':
      try {
        return await pushSnapshot(ctx, { dryRun: args.includes('--dry-run') });
      } catch (err) {
        return { kind: 'error', text: `上传失败：${err.message}` };
      }

    case 'list':
      try {
        const config = loadConfig();
        const client = await createClient(ctx, config);
        const snapshots = await remoteSnapshots(client, config);
        return { kind: 'success', text: listReport(snapshots), data: snapshots };
      } catch (err) {
        return { kind: 'error', text: `读取远端失败：${err.message}` };
      }

    case 'diff':
      try {
        const { snapshot, archive, sidecarNote } = await fetchSnapshot(ctx, args[0]);
        const config = loadConfig();
        // 与打包侧一致：配了口令就用来解 __ENC 令牌，与是否打包 .credentials.yaml 无关
        // 口令优先取独立槽，没有就用 WebDAV 应用密码（与打包侧一致）
        const restoreKey =
          (await resolvePassword(ctx.credentials, config.secretPasswordRef)) ??
          (await resolvePassword(ctx.credentials, config.passwordRef));
        const plan = planRestore(archive, { password: restoreKey });
        return {
          kind: 'success',
          text: `${snapshot.name}（${snapshot.bytes} 字节${sidecarNote}）\n${formatPlan(plan)}\n预演结束，未写入任何文件。`,
          data: {
            action: 'diff',
            snapshot: { name: snapshot.name, bytes: snapshot.bytes, lastModified: snapshot.lastModified },
            counts: plan.counts,
            changes: plan.items.filter((item) => item.status !== 'same').map((item) => ({ path: item.path, status: item.status, bytes: item.bytes })),
            placeholders: plan.placeholders,
            skipped: plan.skipped,
            sidecarNote,
          },
        };
      } catch (err) {
        return { kind: 'error', text: `预演失败：${err.message}` };
      }

    case 'pull':
      try {
        const yes = args.includes('--yes');
        const name = args.find((token) => !token.startsWith('--'));
        const { snapshot, archive, sidecarNote } = await fetchSnapshot(ctx, name);
        const config = loadConfig();
        // 与打包侧一致：配了口令就用来解 __ENC 令牌，与是否打包 .credentials.yaml 无关
        // 口令优先取独立槽，没有就用 WebDAV 应用密码（与打包侧一致）
        const restoreKey =
          (await resolvePassword(ctx.credentials, config.secretPasswordRef)) ??
          (await resolvePassword(ctx.credentials, config.passwordRef));
        const plan = planRestore(archive, { password: restoreKey });
        if (!yes) {
          return {
            kind: 'success',
            text: `${snapshot.name}${sidecarNote}\n${formatPlan(plan)}\n\n确认后执行：/csync pull ${snapshot.name} --yes（先备份现有文件，失败自动回滚）`,
            data: {
              action: 'diff',
              snapshot: { name: snapshot.name, bytes: snapshot.bytes, lastModified: snapshot.lastModified },
              counts: plan.counts,
              changes: plan.items.filter((item) => item.status !== 'same').map((item) => ({ path: item.path, status: item.status, bytes: item.bytes })),
              placeholders: plan.placeholders,
              skipped: plan.skipped,
              sidecarNote,
              needsConfirm: true,
            },
          };
        }
        const result = applyRestore(plan, { password: restoreKey, allowScripts: args.includes('--allow-scripts') });
        saveState({ lastPull: { name: snapshot.name, written: result.written, at: new Date().toISOString() } });
        const lines = [`已恢复 ${snapshot.name}：写入 ${result.written} 个文件`, `   备份目录 ${result.backupDir}`];
        if (result.decrypted) lines.push(`   已用口令还原 ${result.decrypted} 处密钥`);
        const needManual = plan.placeholders.filter((item) => !item.encrypted);
        if (needManual.length) {
          lines.push(`   ${needManual.length} 处占位符 __SECRET__ 需重填：`);
          for (const item of needManual.slice(0, 8)) lines.push(`      ${item.path}：${item.key}`);
        }
        if (result.decryptFailed) lines.push(`   注意：${result.decryptFailed} 处令牌口令不匹配，已原样保留`);
        if (result.sanitized?.length) {
          for (const item of result.sanitized) {
            lines.push(`   已丢弃快照里不可信的依赖写法：${item.dropped.slice(0, 4).join('、')}${item.dropped.length > 4 ? ` 等 ${item.dropped.length} 项` : ''}`);
          }
        }
        if (result.skippedManifests?.length) {
          lines.push(`   已跳过无法解析的清单：${result.skippedManifests.join('、')}`);
        }
        if (result.blockedConfigs?.length) {
          for (const item of result.blockedConfigs) {
            lines.push(`   已拦下会暴露监听地址的配置：${item.path}（${item.reason}）`);
          }
        }
        if (result.skippedDerived?.length) {
          lines.push(`   已跳过派生文件（用 pnpm install 重建）：${result.skippedDerived.join('、')}`);
        }
        if (result.skippedScripts?.length) {
          lines.push(`   已跳过 ${result.skippedScripts.length} 个技能脚本（需要时加 --allow-scripts）：${result.skippedScripts.slice(0, 5).join('、')}`);
        }
        lines.push('   重启 DSH 后新技能 / MCP 才会完全生效。');
        if (result.relinked?.length) {
          lines.push(`   已将 ${result.relinked.length} 个 link 插件指向 ~/.dsh/local-plugins：${result.relinked.join('、')}`);
        }
        if (plan.items.some((item) => item.path.startsWith('plugins/'))) {
          lines.push('   插件源码已就位；重启前需在 profile 目录执行一次 pnpm install（或 dsh plugin add）以重建 node_modules。');
        }
        return {
          kind: 'success',
          text: lines.join('\n'),
          data: {
            action: 'pull',
            snapshot: { name: snapshot.name, bytes: snapshot.bytes },
            written: result.written,
            backupDir: result.backupDir,
            placeholders: plan.placeholders,
            counts: plan.counts,
          },
        };
      } catch (err) {
        return { kind: 'error', text: `恢复失败：${err.message}` };
      }

    case 'delete': {
      const name = args[0];
      if (!name) return { kind: 'error', text: '用法：/csync delete <快照名>' };
      if (name.includes('/') || name.includes('..')) return { kind: 'error', text: '快照名不合法' };
      try {
        const config = loadConfig();
        const client = await createClient(ctx, config);
        const snapshots = await remoteSnapshots(client, config);
        if (!snapshots.some((item) => item.name === name)) {
          return { kind: 'error', text: `远端没有该快照：${name}` };
        }
        await client.remove(`${config.remoteDir}/${name}`);
        const sidecar = `${name}.sha256`;
        if (snapshots.some((item) => item.name === sidecar)) {
          await client.remove(`${config.remoteDir}/${sidecar}`);
        }
        return {
          kind: 'success',
          text: `已删除 ${name}`,
          data: { action: 'delete', name },
        };
      } catch (err) {
        return { kind: 'error', text: `删除失败：${err.message}` };
      }
    }

    case 'prune':
      try {
        const config = loadConfig();
        const client = await createClient(ctx, config);
        const removed = await applyRetention(client, config, await remoteSnapshots(client, config));
        return { kind: 'success', text: removed.length ? `已删除 ${removed.join(', ')}` : '无超出保留份数的快照。' };
      } catch (err) {
        return { kind: 'error', text: `清理失败：${err.message}` };
      }

    case 'help':
      return { kind: 'success', text: USAGE };

    default:
      return { kind: 'error', text: `未知子命令 ${sub}\n${USAGE}` };
  }
}
