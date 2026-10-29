/**
 * 自动同步：定时（interval）与改动触发（watch）两种模式。
 *
 * 设计取舍：
 * - 单一 30 秒轮询驱动，配置改动无需重启插件即可生效；
 * - 推送前先比对「文件清单指纹」（路径 + 字节数 + 修改时间），
 *   与上次推送记录一致就不再打包上传，避免定时任务把同样的 60MB 反复推；
 * - 与手动上传共用 pushSnapshot，保留策略、state.lastPush、UI 进度都一致；
 * - 任何异常只写日志，绝不打断会话。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  loadConfig,
  loadState,
  resolveAgentsHome,
  resolveDshHome,
  resolveProfileName,
  saveState,
} from './config.js';
import { collectSections } from './sections.js';

// 轮询间隔；环境变量仅用于测试时加速（生产保持 30 秒）
const TICK_MS = Math.max(500, Number(process.env.CLOUD_SYNC_TICK_MS) || 30 * 1000);

/** 兼容旧配置：只配了 autoSyncHours 时按定时模式处理。 */
export function readAutoSync(config) {
  const legacyHours = Number(config.autoSyncHours) || 0;
  const rawMode = config.autoSyncMode;
  const mode = rawMode === 'watch' || rawMode === 'interval'
    ? rawMode
    : rawMode === 'off'
      ? 'off'
      : legacyHours > 0 ? 'interval' : 'off';
  const minutes = Math.max(1, Math.round(Number(config.autoSyncMinutes) || (legacyHours > 0 ? legacyHours * 60 : 60)));
  const debounceSeconds = Math.max(10, Math.round(Number(config.autoSyncDebounceSeconds) || 90));
  return { mode, minutes, debounceSeconds };
}

export function describeAutoSync(config) {
  const { mode, minutes, debounceSeconds } = readAutoSync(config);
  if (mode === 'interval') return `每 ${minutes} 分钟`;
  if (mode === 'watch') return `改动后 ${debounceSeconds} 秒`;
  return '关闭';
}

function sectionPaths() {
  return { dshHome: resolveDshHome(), agentsHome: resolveAgentsHome(), profile: resolveProfileName() };
}

/**
 * 文件清单指纹：只做 stat，不读内容，几百个文件在毫秒级。
 * 用于「内容没变就不重复上传」，比对比 mtime 更稳（touch 也算改动）。
 */
export function computeFingerprint(config) {
  const { files } = collectSections(config, sectionPaths());
  const digest = crypto.createHash('sha1');
  for (const file of [...files].sort((a, b) => a.archivePath.localeCompare(b.archivePath))) {
    digest.update(`${file.archivePath}\u0000${file.bytes}\u0000${file.mtimeMs}\n`);
  }
  return digest.digest('hex');
}

/** 需要监听改动的根目录（只挑真实的同步来源，避免盯住 sessions 这类高频目录）。 */
export function watchRoots(config) {
  const { dshHome, agentsHome, profile } = sectionPaths();
  const sections = new Set(config.sections ?? []);
  const roots = [];
  const add = (target, recursive) => {
    try {
      if (!fs.existsSync(target)) return;
      if (roots.some((item) => item.path === target)) return;
      roots.push({ path: target, recursive });
    } catch { /* 忽略不可读目录 */ }
  };

  if (sections.has('skills')) add(path.join(dshHome, 'skills'), true);
  if (sections.has('agentsSkills')) add(path.join(agentsHome, 'skills'), true);
  if (sections.has('mcp')) add(path.join(dshHome, 'profiles', profile), false);
  if (sections.has('instructions')) {
    add(dshHome, false);
    add(agentsHome, false);
  }
  if (sections.has('plugins')) {
    const manifestPath = path.join(dshHome, 'profiles', profile, 'package.json');
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
        if (typeof spec !== 'string' || !spec.startsWith('link:')) continue;
        add(path.resolve(path.dirname(manifestPath), spec.slice(5)), true);
      }
    } catch { /* 没有 profile 清单就只监听目录类来源 */ }
  }
  return roots;
}

/**
 * 启动自动同步。返回 stop()。
 * onPush 由调用方注入（宿主里传 pushSnapshot），返回 { kind, text }。
 */
export function startAutoSync({ onPush, logger }) {
  let timer = null;
  let ticking = false;
  let running = false;
  let stopped = false;
  let dirtyAt = 0;
  let watchers = [];
  let watchedKey = '';
  let debounceTimer = null;

  const log = (level, message, ...args) => {
    try { logger?.[level]?.(message, ...args); } catch { /* 日志失败不影响同步 */ }
  };

  const markChanged = () => {
    dirtyAt = Date.now();
    if (debounceTimer) clearTimeout(debounceTimer);
    // 防抖：连续写入结束后再等一个窗口
    debounceTimer = setTimeout(() => { dirtyAt = Date.now(); }, 1000);
    if (debounceTimer.unref) debounceTimer.unref();
  };

  const refreshWatchers = (config) => {
    const { mode } = readAutoSync(config);
    const roots = mode === 'watch' ? watchRoots(config) : [];
    const key = JSON.stringify(roots);
    if (key === watchedKey) return;
    watchedKey = key;
    for (const watcher of watchers) {
      try { watcher.close(); } catch { /* ignore */ }
    }
    watchers = [];
    for (const root of roots) {
      try {
        const watcher = fs.watch(root.path, { recursive: root.recursive, persistent: false }, markChanged);
        watchers.push(watcher);
      } catch (err) {
        log('warn', '[cloud-sync] 监听 %s 失败：%s', root.path, err?.message ?? err);
      }
    }
    if (roots.length) log('info', '[cloud-sync] 改动监听已启用：%d 个目录', roots.length);
  };

  const tick = async () => {
    if (stopped || ticking) return;
    ticking = true;
    try {
      const config = loadConfig();
      const { mode, minutes, debounceSeconds } = readAutoSync(config);
      refreshWatchers(config);
      if (mode === 'off' || running) return;

      const state = loadState();

      // 改动模式首次启用只记录基线，避免一开开关就传一份 60MB；
      // 定时模式没有基线说明从未备份过，按周期正常推送。
      if (mode === 'watch' && !state.lastFingerprint) {
        saveState({ lastFingerprint: computeFingerprint(config) });
        dirtyAt = 0;
        return;
      }

      if (mode === 'interval') {
        const last = Date.parse(state.lastAutoPushAt ?? '') || 0;
        const sinceLastPush = Date.parse(state.lastPush?.at ?? '') || 0;
        // 只按「上次自动推送」计时，但手动推送过也会顺延，避免刚手动传完又自动传
        if (Date.now() - Math.max(last, sinceLastPush) < minutes * 60 * 1000) return;
      } else {
        if (!dirtyAt) return;
        if (Date.now() - dirtyAt < debounceSeconds * 1000) return;
      }

      const fingerprint = computeFingerprint(config);
      if (fingerprint === state.lastFingerprint) {
        dirtyAt = 0;
        return;
      }

      running = true;
      try {
        const result = await onPush();
        if (result?.kind === 'success') {
          saveState({ lastFingerprint: fingerprint, lastAutoPushAt: new Date().toISOString() });
          dirtyAt = 0;
          log('info', '[cloud-sync] 自动同步完成：%s', String(result.text ?? '').split('\n')[0]);
        } else {
          log('warn', '[cloud-sync] 自动同步未完成：%s', String(result?.text ?? '').split('\n')[0]);
        }
      } finally {
        running = false;
      }
    } catch (err) {
      log('warn', '[cloud-sync] 自动同步失败：%s', err?.message ?? err);
    } finally {
      ticking = false;
    }
  };

  timer = setInterval(tick, TICK_MS);
  if (timer.unref) timer.unref();
  const kickoff = setTimeout(tick, 5000);
  if (kickoff.unref) kickoff.unref();

  return function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    if (debounceTimer) clearTimeout(debounceTimer);
    for (const watcher of watchers) {
      try { watcher.close(); } catch { /* ignore */ }
    }
    watchers = [];
  };
}
