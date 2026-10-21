/**
 * dsh-cloud-sync · 宿主半区
 *
 * 把 DSH 的可移植配置（技能、共享技能、MCP/profile 行、全局指令、可选凭据）
 * 打包成单个 .tar.gz 推到 WebDAV（默认坚果云，也兼容 Nextcloud / 群晖），并支持拉取恢复。
 *
 * 宿主半区做两件事：
 *   1. 注册 /nsync 命令（命令行入口）
 *   2. 暴露 /cloud-sync/api/* 只读+动作 HTTP 路由（设置页卡片用）
 */
import { loadConfig } from './config.js';
import { USAGE, runSubcommand, stateSnapshot } from './actions.js';
import { getService, pushSnapshot } from './sync.js';

export const name = 'cloud-sync';
// webServer 必须显式注入：仅用 ctx.get('webServer') 在 apply 时可能还没挂上，
// 会导致路由静默注册失败（实测表现：/cloud-sync/api/* 返回 404）。
export const inject = ['commands', 'webServer'];

const API_PREFIX = '/cloud-sync/api';

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

/** 设置页用的 HTTP API：同一份 runSubcommand 逻辑，避免两套行为漂移。 */
export function registerRoutes(ctx) {
  const webServer = ctx.webServer ?? getService(ctx, 'webServer');
  if (!webServer?.register) return false;

  return webServer.register({
    kind: 'prefix',
    path: '/cloud-sync',
    handler: async (req, res) => {
      const pathname = (req.url || '').split('?')[0];
      try {
        if (pathname === `${API_PREFIX}/state` || pathname === `${API_PREFIX}/state/`) {
          return sendJson(res, 200, { ok: true, data: await stateSnapshot(ctx) });
        }
        if (pathname === `${API_PREFIX}/action` && req.method === 'POST') {
          const body = await readJsonBody(req);
          const tokens = Array.isArray(body.args) ? body.args : String(body.command ?? '').trim().split(/\s+/).filter(Boolean);
          const result = await runSubcommand(ctx, tokens);
          return sendJson(res, 200, { ok: result.kind === 'success', text: result.text, data: result.data ?? null });
        }
        return sendJson(res, 404, { ok: false, text: 'not found' });
      } catch (err) {
        return sendJson(res, 500, { ok: false, text: String(err?.message ?? err) });
      }
    },
  });
}

export function apply(ctx) {
  ctx.effect(function* () {
    yield ctx.commands.register({
      name: 'csync',
      description: '云同步：把 DSH 配置备份到 WebDAV / 从 WebDAV 恢复',
      input: { hint: 'status | config | secret | push | list | diff | pull' },
      handler: (invocation) => runSubcommand(ctx, invocation.rawInput.trim().split(/\s+/).filter(Boolean)),
    });
    yield ctx.commands.register({
      name: 'nsync',
      description: '云同步：把 DSH 配置备份到 WebDAV / 从 WebDAV 恢复',
      input: { hint: 'status | config | secret | push | list | diff | pull' },
      handler: (invocation) => runSubcommand(ctx, invocation.rawInput.trim().split(/\s+/).filter(Boolean)),
    });
  }, 'cloud-sync commands');

  ctx.effect(function* () {
    const disposable = registerRoutes(ctx);
    const logger = getService(ctx, 'logger') ?? ctx.logger;
    logger?.info?.('[cloud-sync] routes %s at %s', disposable ? 'registered' : 'SKIPPED (no webServer)', API_PREFIX);
    if (disposable && typeof disposable === 'function') yield disposable;
  }, 'cloud-sync routes');

  // 可选：定时自动推送（默认关闭；失败只记日志，绝不打断会话）
  ctx.effect(function* () {
    const hours = Number(loadConfig().autoSyncHours) || 0;
    if (hours <= 0 || typeof ctx.interval !== 'function') return;
    let running = false;
    const logger = getService(ctx, 'logger');
    const handle = ctx.interval(async () => {
      if (running) return;
      running = true;
      try {
        const result = await pushSnapshot(ctx, { dryRun: false });
        logger?.info?.('[cloud-sync] 自动同步：%s', result.text.split('\n')[0]);
      } catch (err) {
        logger?.warn?.('[cloud-sync] 自动同步失败：%s', err?.message ?? err);
      } finally {
        running = false;
      }
    }, hours * 3600 * 1000);
    if (handle && typeof handle.unref === 'function') handle.unref();
    yield () => { if (typeof handle === 'function') handle(); };
  }, 'cloud-sync auto-sync');
}

export { USAGE };
