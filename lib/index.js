/**
 * dsh-cloud-sync · 宿主半区
 *
 * 把 DSH 的可移植配置（技能、共享技能、MCP/profile 行、全局指令、可选凭据）
 * 打包成单个 .tar.gz 推到 WebDAV（默认坚果云，也兼容 Nextcloud / 群晖），并支持拉取恢复。
 *
 * 宿主半区做两件事：
 *   1. 注册 /csync 命令（命令行入口）
 *   2. 暴露 /cloud-sync/api/* 只读+动作 HTTP 路由（设置页卡片用）
 */
import { loadConfig } from './config.js';
import { describeAutoSync, startAutoSync } from './autosync.js';
import { USAGE, runSubcommand, stateSnapshot } from './actions.js';
import { getService, pushSnapshot } from './sync.js';

export const name = 'cloud-sync';
// webServer 必须显式注入：仅用 ctx.get('webServer') 在 apply 时可能还没挂上，
// 会导致路由静默注册失败（实测表现：/cloud-sync/api/* 返回 404）。
export const inject = ['commands', 'webServer'];

const API_PREFIX = '/cloud-sync/api';

/**
 * 这些接口能改 WebDAV 地址、跑恢复、删远端快照，而宿主 Web 服务不做会话校验。
 * 只信任「本机回环 + 同源」：Host 挡 DNS rebinding，Origin 挡跨站 POST。
 * 隧道代理会把 Host/Origin 重写成上游地址（dsh-mobile-control 的 proxyRequest），
 * 所以手机端不受影响。
 */
function isLoopbackHost(hostHeader) {
  if (!hostHeader) return false;
  const host = String(hostHeader).trim().toLowerCase();
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, '');
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1';
}

function isSameOrigin(originHeader, selfOrigin) {
  const origin = String(originHeader || '').trim()
  if (!origin) return true // 非浏览器客户端（curl / 测试）不带 Origin
  if (origin === 'null') return false // file:// 或 sandbox iframe
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  // 只放行回环来源：localhost 与 127.0.0.1 视为同一个服务（端口必须一致）。
  // evil.example 即使解析到 127.0.0.1，Origin 仍是它自己的域名，过不了这一关。
  if (!/^https?:$/.test(parsed.protocol) || !isLoopbackHost(parsed.host)) return false
  if (!selfOrigin) return true
  try {
    return new URL(selfOrigin).port === parsed.port
  } catch {
    return false
  }
}

/** 超过上限返回 null（调用方给 413），不要把截断后的半截 JSON 当「格式错误」。 */
async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
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
      const selfOrigin = (() => {
        try { return new URL(webServer.getOrigin?.() ?? '').origin; } catch { return ''; }
      })();
      if (!isLoopbackHost(req.headers?.host)) return sendJson(res, 403, { ok: false, text: 'forbidden-host' });
      if (!isSameOrigin(req.headers?.origin, selfOrigin)) return sendJson(res, 403, { ok: false, text: 'forbidden-origin' });
      try {
        if (pathname === `${API_PREFIX}/state` || pathname === `${API_PREFIX}/state/`) {
          return sendJson(res, 200, { ok: true, data: await stateSnapshot(ctx) });
        }
        if (pathname === `${API_PREFIX}/action` && req.method === 'POST') {
          const body = await readJsonBody(req);
          if (body === null) return sendJson(res, 413, { ok: false, text: 'body too large' });
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
  }, 'cloud-sync commands');

  ctx.effect(function* () {
    const disposable = registerRoutes(ctx);
    const logger = getService(ctx, 'logger') ?? ctx.logger;
    logger?.info?.('[cloud-sync] routes %s at %s', disposable ? 'registered' : 'SKIPPED (no webServer)', API_PREFIX);
    if (disposable && typeof disposable === 'function') yield disposable;
  }, 'cloud-sync routes');

  // 自动同步：定时 / 改动后触发（默认关闭；失败只记日志，绝不打断会话）
  ctx.effect(function* () {
    const logger = getService(ctx, 'logger') ?? ctx.logger;
    const stop = startAutoSync({
      logger,
      onPush: (options) => pushSnapshot(ctx, { dryRun: false, ...(options ?? {}) }),
    });
    logger?.info?.('[cloud-sync] 自动同步已就绪（当前：%s）', describeAutoSync(loadConfig()));
    yield stop;
  }, 'cloud-sync auto-sync');
}

export { USAGE };
