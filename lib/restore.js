/**
 * 拉取与恢复：把归档里的条目映射回本地路径，先出计划，确认后再落盘，落盘前先备份。
 * 任何一步失败都会用备份回滚。
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveAgentsHome, resolveDshHome, resolveProfileName } from './config.js';
import { openBundle, formatBytes } from './bundle.js';
import { sha256 } from './sections.js';

/**
 * 归档内路径 → 本地绝对路径。
 * 返回 null 表示该条目不由本插件管理（例如加密的 secrets 负载）。
 */
export function localPathFor(archivePath, paths = {}) {
  const dshHome = paths.dshHome ?? resolveDshHome();
  const agentsHome = paths.agentsHome ?? resolveAgentsHome();
  const profile = paths.profile ?? resolveProfileName();
  const [section, ...rest] = archivePath.split('/');
  const tail = rest.join('/');
  if (!tail) return null;
  switch (section) {
    case 'skills':
      return path.join(dshHome, 'skills', ...rest);
    case 'agents-skills':
      return path.join(agentsHome, 'skills', ...rest);
    case 'mcp':
      return path.join(dshHome, 'profiles', profile, ...rest);
    case 'instructions':
      return path.join(dshHome, ...rest);
    case 'instructions-agents':
      return path.join(agentsHome, ...rest);
    case 'storages':
      return path.join(dshHome, 'storages', ...rest);
    case 'plugins':
      // link: 插件源码恢复到稳定目录，换机器不再依赖原来的绝对路径
      return path.join(dshHome, 'local-plugins', ...rest);
    default:
      return null; // secrets/* 等
  }
}

const PLACEHOLDER = Buffer.from('__SECRET__');

/**
 * 计算恢复计划（零写入）。
 *
 * 关键保护：归档里的密钥是 `__SECRET__` 占位符。若本地文件已有真实值，
 * 直接覆盖等于用占位符冲掉用户的真密钥，因此这类条目判为 secret-protected，
 * 不参与落盘，只在计划里报告。
 * @returns {{items: Array, counts: Record<string, number>, placeholders: Array, skipped: number}}
 */
export function planRestore(archive, paths = {}) {
  const resolved = {
    dshHome: paths.dshHome ?? resolveDshHome(),
    agentsHome: paths.agentsHome ?? resolveAgentsHome(),
    profile: paths.profile ?? resolveProfileName(),
  };
  const { manifest, files, mismatched } = openBundle(archive);
  if (mismatched.length) {
    throw new Error(`归档校验失败，拒绝恢复：${mismatched.slice(0, 3).join('；')}`);
  }
  const items = [];
  let skipped = 0;
  for (const file of files) {
    const target = localPathFor(file.path, resolved);
    if (!target) {
      skipped++;
      continue;
    }
    const exists = fs.existsSync(target);
    const current = exists ? fs.readFileSync(target) : null;
    const currentDigest = current ? sha256(current) : null;
    const incomingDigest = sha256(file.data);
    let status;
    if (!exists) status = 'new';
    else if (currentDigest === incomingDigest) status = 'same';
    else if (file.data.includes(PLACEHOLDER) && !current.includes(PLACEHOLDER)) status = 'protected';
    else status = 'changed';
    items.push({ path: file.path, target, status, bytes: file.data.length, data: file.data });
  }
  const counts = { new: 0, changed: 0, same: 0, protected: 0 };
  for (const item of items) counts[item.status]++;
  return { manifest, items, counts, placeholders: manifest.placeholders ?? [], skipped, paths: resolved };
}

export function formatPlan(plan) {
  const lines = [];
  lines.push(
    `📥 恢复计划：新增 ${plan.counts.new}｜覆盖 ${plan.counts.changed}｜一致跳过 ${plan.counts.same}` +
      (plan.counts.protected ? `｜密钥保护跳过 ${plan.counts.protected}` : '') +
      (plan.skipped ? `｜非本地条目 ${plan.skipped}` : ''),
  );
  const interesting = plan.items.filter((item) => item.status !== 'same');
  for (const item of interesting.slice(0, 12)) {
    const mark = item.status === 'new' ? '＋' : item.status === 'protected' ? '🔒' : '↻';
    lines.push(`   ${mark} ${item.path} (${formatBytes(item.bytes)})`);
  }
  if (interesting.length > 12) lines.push(`   … 其余 ${interesting.length - 12} 项`);
  if (plan.counts.protected) {
    lines.push(`   ⚠️ ${plan.counts.protected} 个文件本地已有真实密钥，归档里只有 __SECRET__ 占位符，已跳过不覆盖。`);
  }
  if (plan.placeholders.length) {
    lines.push(`   🔒 归档内有 ${plan.placeholders.length} 处密钥占位符 __SECRET__，恢复后需要重填：`);
    for (const item of plan.placeholders.slice(0, 6)) lines.push(`      ${item.path} → ${item.key}`);
  }
  return lines.join('\n');
}

/**
 * 落盘。先备份将被覆盖/被替换的现有文件到 backupDir，失败则整体回滚。
 * @returns {{written: number, backupDir: string, rollback: () => number}}
 */
export function applyRestore(plan, { backupRoot } = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(backupRoot ?? path.join(resolveDshHome(), 'cloud-sync'), `backup-${stamp}`);
  const undo = [];
  let written = 0;

  try {
    for (const item of plan.items) {
      if (item.status === 'same' || item.status === 'protected') continue;
      if (fs.existsSync(item.target)) {
        const relative = path.relative(path.parse(item.target).root, item.target);
        const backupPath = path.join(backupDir, relative);
        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
        fs.copyFileSync(item.target, backupPath);
        undo.push({ type: 'restore', target: item.target, backupPath });
      } else {
        undo.push({ type: 'remove', target: item.target });
      }
      fs.mkdirSync(path.dirname(item.target), { recursive: true });
      fs.writeFileSync(item.target, item.data);
      written++;
    }
  } catch (err) {
    rollback(undo);
    throw new Error(`恢复失败并已回滚：${err.message}`);
  }

  const relinked = relinkPlugins(plan, { backupDir, ...(plan.paths ?? {}) });
  return { written, backupDir, relinked, rollback: () => rollback(undo) };
}

/**
 * 把恢复出来的 link: 插件接到稳定目录上。
 *
 * 换机器后 profile/package.json 里的 link: 还指着旧机器的绝对路径，
 * 这里只在该目标不存在时才改写（本机路径有效就不动）。
 * @returns {string[]} 被改写的包名
 */
function relinkPlugins(plan, { dshHome, profile, backupDir } = {}) {
  const home = dshHome ?? resolveDshHome();
  const profileName = profile ?? resolveProfileName();
  const profileDir = path.join(home, 'profiles', profileName);
  const manifestPath = path.join(profileDir, 'package.json');
  const names = [...new Set(plan.items
    .filter((item) => item.path.startsWith('plugins/'))
    .map((item) => {
      // plugins/@scope/name/... 或 plugins/name/...
      const segments = item.path.split('/').slice(1);
      return segments[0] && segments[0].startsWith('@') ? `${segments[0]}/${segments[1]}` : segments[0];
    })
    .filter(Boolean))];
  if (!names.length || !fs.existsSync(manifestPath)) return [];

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return [];
  }
  const dependencies = manifest.dependencies ?? {};
  const rewritten = [];
  for (const name of names) {
    const spec = dependencies[name];
    if (typeof spec !== 'string' || !spec.startsWith('link:')) continue;
    const current = path.resolve(profileDir, spec.slice(5));
    if (fs.existsSync(current)) continue; // 本机路径可用，不动
    const target = path.resolve(home, 'local-plugins', name);
    dependencies[name] = `link:${target.split(path.sep).join('/')}`;
    rewritten.push(name);
  }
  if (!rewritten.length) return [];

  try {
    fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(manifestPath, path.join(backupDir, 'package.json.before-relink'));
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  } catch {
    return [];
  }
  return rewritten;
}

function rollback(undo) {
  let reverted = 0;
  for (const step of undo.reverse()) {
    try {
      if (step.type === 'restore') {
        fs.copyFileSync(step.backupPath, step.target);
      } else if (fs.existsSync(step.target)) {
        fs.rmSync(step.target, { force: true });
      }
      reverted++;
    } catch {
      /* 回滚尽力而为，失败项留在备份目录里人工恢复 */
    }
  }
  return reverted;
}
