/**
 * 子命令实现：命令层与设置页 HTTP API 共用同一份逻辑，避免两套行为漂移。
 * 输入是拆分后的 token；返回 { kind, text, data? }。
 */
import os from 'node:os';
import { loadConfig, loadState, resolvePassword, saveConfig, saveState } from './config.js';
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

export function formatConfig(config) {
  const lines = ['🌰 云同步 · 配置'];
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
  return {
    config,
    credentialConfigured,
    secretPasswordConfigured,
    snapshots,
    remoteError,
    state: loadState(),
    progress: { ...progress },
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
      if (!key) return { kind: 'success', text: formatConfig(loadConfig()), data: loadConfig() };
      if (!rest.length) {
        const config = loadConfig();
        if (!(key in config)) return { kind: 'error', text: `未知配置键：${key}\n${formatConfig(config)}` };
        return { kind: 'success', text: `${key} = ${JSON.stringify(config[key])}` };
      }
      const value = parseConfigValue(rest.join(' '));
      const next = saveConfig({ [key]: value });
      return { kind: 'success', text: `✅ ${key} = ${JSON.stringify(next[key])}`, data: next };
    }

    case 'secret': {
      const secret = args.join(' ');
      if (!secret) return { kind: 'error', text: '用法：/csync secret <WebDAV 应用密码>' };
      const credentials = getService(ctx, 'credentials');
      if (!credentials?.set) return { kind: 'error', text: '当前宿主没有 credentials 服务，无法写入凭据槽。' };
      const config = loadConfig();
      try {
        await credentials.set(config.passwordRef, secret);
        return { kind: 'success', text: `✅ 已写入凭据槽 ${config.passwordRef}` };
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
      const credentials = getService(ctx, 'credentials');
      if (!credentials?.set) return { kind: 'error', text: '当前宿主没有 credentials 服务，无法写入凭据槽。' };
      try {
        await credentials.set(ref, value);
        return { kind: 'success', text: `✅ 已写入凭据槽 ${ref}` };
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
        const restoreKey = config.includeSecrets
          ? await resolvePassword(ctx.credentials, config.secretPasswordRef)
          : null;
        const plan = planRestore(archive, { password: restoreKey });
        return {
          kind: 'success',
          text: `🌰 ${snapshot.name}（${snapshot.bytes} 字节${sidecarNote}）\n${formatPlan(plan)}\n（这是预演，未写入任何文件）`,
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
        const restoreKey = config.includeSecrets
          ? await resolvePassword(ctx.credentials, config.secretPasswordRef)
          : null;
        const plan = planRestore(archive, { password: restoreKey });
        if (!yes) {
          return {
            kind: 'success',
            text: `🌰 ${snapshot.name}${sidecarNote}\n${formatPlan(plan)}\n\n确认后执行：/csync pull ${snapshot.name} --yes（先备份现有文件，失败自动回滚）`,
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
        const result = applyRestore(plan, { password: restoreKey });
        saveState({ lastPull: { name: snapshot.name, written: result.written, at: new Date().toISOString() } });
        const lines = [`✅ 已恢复 ${snapshot.name}：写入 ${result.written} 个文件`, `   备份目录 ${result.backupDir}`];
        if (result.decrypted) lines.push(`   🔓 已用口令还原 ${result.decrypted} 处密钥`);
        const needManual = plan.placeholders.filter((item) => !item.encrypted);
        if (needManual.length) {
          lines.push(`   🔒 有 ${needManual.length} 处明文占位符 __SECRET__ 需要重填：`);
          for (const item of needManual.slice(0, 8)) lines.push(`      ${item.path} → ${item.key}`);
        }
        if (result.decryptFailed) lines.push(`   ⚠️ ${result.decryptFailed} 处令牌口令不匹配，已原样保留`);
        lines.push('   重启 DSH 后新技能 / MCP 才会完全生效。');
        if (result.relinked?.length) {
          lines.push(`   🔗 已把 ${result.relinked.length} 个 link 插件指向 ~/.dsh/local-plugins：${result.relinked.join('、')}`);
        }
        if (plan.items.some((item) => item.path.startsWith('plugins/'))) {
          lines.push('   ⚙️ 插件源码已就位，重启前需在 profile 目录执行一次 pnpm install（或 dsh plugin add）重建 node_modules。');
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

    case 'prune':
      try {
        const config = loadConfig();
        const client = await createClient(ctx, config);
        const removed = await applyRetention(client, config, await remoteSnapshots(client, config));
        return { kind: 'success', text: removed.length ? `🧹 已删除 ${removed.join(', ')}` : '没有超出保留份数的快照。' };
      } catch (err) {
        return { kind: 'error', text: `清理失败：${err.message}` };
      }

    case 'help':
      return { kind: 'success', text: USAGE };

    default:
      return { kind: 'error', text: `未知子命令 ${sub}\n${USAGE}` };
  }
}
