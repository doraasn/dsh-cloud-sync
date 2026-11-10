/**
 * 拉取与恢复：把归档里的条目映射回本地路径，先出计划，确认后再落盘，落盘前先备份。
 * 任何一步失败都会用备份回滚。
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveAgentsHome, resolveDshHome, resolveProfileName } from './config.js';
import { openBundle, formatBytes } from './bundle.js';
import { openInlineSecrets } from './secrets.js';
import { sha256 } from './sections.js';

/**
 * 归档内路径来自远端快照（可能是别人放上去的，也可能在传输中被改过），
 * 必须钉死在各自根目录下：`skills/../../evil.txt` 这类条目一律判为「不归我管」，
 * 否则恢复就等于任意写盘（写 AGENTS.md / cordis.patch.yml 即可持久化代码执行）。
 */
function within(root, segments) {
  const base = path.resolve(root);
  const target = path.resolve(base, ...segments);
  const rel = path.relative(base, target);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return target;
}

/**
 * 把归档内路径解析为本地绝对路径。
 * 返回 null 表示该条目不由本插件管理（例如加密的 secrets 负载，或越界路径）。
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
      return within(dshHome, ['skills', ...rest]);
    case 'agents-skills':
      return within(agentsHome, ['skills', ...rest]);
    case 'mcp':
      return within(dshHome, ['profiles', profile, ...rest]);
    case 'instructions':
      return within(dshHome, rest);
    case 'instructions-agents':
      return within(agentsHome, rest);
    case 'storages':
      return within(dshHome, ['storages', ...rest]);
    case 'memories':
      return within(dshHome, ['memories', ...rest]);
    case 'local-plugins':
      return within(dshHome, ['local-plugins', ...rest]);
    case 'agents':
      return within(agentsHome, rest);
    case 'profiles':
      return within(dshHome, ['profiles', ...rest]);
    case 'plugins':
      // link: 插件源码恢复到稳定目录，换机器不再依赖原来的绝对路径
      return within(dshHome, ['local-plugins', ...rest]);
    default:
      return null; // secrets/* 等
  }
}

const PLACEHOLDER = Buffer.from('__SECRET__');
const ENCRYPTED = Buffer.from('__ENC:');
const PLACEHOLDER_TEXT = '__SECRET__';

/**
 * 计算恢复计划（零写入）。
 *
 * 密钥有两种形态：
 *   - `__ENC:...__` 令牌：有口令就能还原成明文，视为正常更新；
 *   - `__SECRET__` 占位符：不可还原，若本地已有真实值则不覆盖（判为 protected）。
 * @returns {{items: Array, counts: Record<string, number>, placeholders: Array, skipped: number}}
 */
export function planRestore(archive, paths = {}) {
  const resolved = {
    dshHome: paths.dshHome ?? resolveDshHome(),
    agentsHome: paths.agentsHome ?? resolveAgentsHome(),
    profile: paths.profile ?? resolveProfileName(),
  };
  const hasKey = Boolean(paths.password);
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
    const sealed = file.data.includes(ENCRYPTED);
    // 有口令也要验一次：口令不对时令牌解不开，不能把密文写进本地配置
    let unopenable = false;
    if (sealed) {
      unopenable = !hasKey || openInlineSecrets(file.data.toString('utf8'), paths.password).failed > 0;
    }
    let status;
    if (!exists) status = 'new';
    else if (currentDigest === incomingDigest) status = 'same';
    else if (unopenable) status = 'protected'; // 解不开就跳过，别覆盖本地真值
    else if (file.data.includes(PLACEHOLDER) && !current.includes(PLACEHOLDER)) status = 'protected';
    else status = 'changed';
    items.push({ path: file.path, target, status, bytes: file.data.length, data: file.data, sealed, unopenable });
  }
  const counts = { new: 0, changed: 0, same: 0, protected: 0 };
  for (const item of items) counts[item.status]++;
  return { manifest, items, counts, placeholders: manifest.placeholders ?? [], skipped, paths: resolved, hasKey };
}

export function formatPlan(plan) {
  const lines = [];
  lines.push(
    `恢复计划：新增 ${plan.counts.new}｜覆盖 ${plan.counts.changed}｜一致跳过 ${plan.counts.same}` +
      (plan.counts.protected ? `｜密钥保护跳过 ${plan.counts.protected}` : '') +
      (plan.skipped ? `｜非本地条目 ${plan.skipped}` : ''),
  );
  const interesting = plan.items.filter((item) => item.status !== 'same');
  for (const item of interesting.slice(0, 12)) {
    const mark = item.status === 'new' ? '+' : item.status === 'protected' ? '!' : '~';
    lines.push(`   ${mark} ${item.path} (${formatBytes(item.bytes)})`);
  }
  if (interesting.length > 12) lines.push(`   … 其余 ${interesting.length - 12} 项`);
  if (plan.counts.protected) {
    lines.push(`   注意：${plan.counts.protected} 个文件本地已有真实密钥，归档内为占位符，已跳过。`);
  }
  if (plan.placeholders.length) {
    lines.push(`   归档内 ${plan.placeholders.length} 处占位符 __SECRET__，恢复后需重填：`);
    for (const item of plan.placeholders.slice(0, 6)) lines.push(`      ${item.path}：${item.key}`);
  }
  return lines.join('\n');
}

/**
 * 落盘。先备份将被覆盖/被替换的现有文件到 backupDir，失败则整体回滚。
 * @returns {{written: number, backupDir: string, rollback: () => number}}
 */
/**
 * 恢复 profile/package.json 前的收敛：只接受本机能验证来源的依赖写法。
 *
 * 快照可能来自被改写的 WebDAV / 别人的归档；若整包照抄 dependencies，
 * 下一次 `pnpm install` 就会拉取并执行攻击者指定的包。因此：
 *   - 只放行 link: / file: / github:doraasn/ 三类（本机路径、本组织仓库）
 *   - bundles 只保留内建 @deepseek-ai/* 与保留下来的依赖名
 * @returns {{manifest: object, dropped: string[]}}
 */
export function sanitizeProfileManifest(manifest) {
  const allowed = /^(link:|file:|github:doraasn\/)/i
  const builtinBundle = /^@deepseek-ai\//
  const out = { ...(manifest ?? {}) }
  const dropped = [];
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const deps = manifest?.[section];
    if (!deps || typeof deps !== 'object') continue;
    const kept = {};
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec === 'string' && allowed.test(spec)) kept[name] = spec;
      else dropped.push(`${section}.${name}=${String(spec)}`);
    }
    out[section] = kept;
  }
  const bundles = manifest?.dsh?.profile?.bundles;
  if (Array.isArray(bundles)) {
    const names = new Set(Object.keys(out.dependencies ?? {}));
    const keptBundles = bundles.filter((item) => typeof item === 'string' && (builtinBundle.test(item) || names.has(item)));
    for (const item of bundles) if (!keptBundles.includes(item)) dropped.push(`bundles.${String(item)}`);
    out.dsh = { ...(out.dsh ?? {}), profile: { ...(out.dsh?.profile ?? {}), bundles: keptBundles } };
  }
  return { manifest: out, dropped };
}

/** 目标是否是 profile 的清单文件（只有它需要收敛依赖写法）。 */
function isProfileManifest(target, paths = {}) {
  const profileName = paths.profile ?? resolveProfileName();
  return path.basename(target) === 'package.json' && path.basename(path.dirname(target)) === profileName;
}

export function applyRestore(plan, { backupRoot, password } = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(backupRoot ?? path.join(resolveDshHome(), 'cloud-sync'), `backup-${stamp}`);
  const undo = [];
  let written = 0;
  let decrypted = 0;
  let decryptFailed = 0;
  const sanitized = [];
  const skippedManifests = [];

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
      // 有口令就把 __ENC: 令牌还原成明文再落盘；解不开的退回 __SECRET__ 占位符
      let data = item.data;
      if (item.sealed) {
        let text = data.toString('utf8');
        if (password) {
          const opened = openInlineSecrets(text, password);
          text = opened.text;
          decrypted += opened.restored;
          decryptFailed += opened.failed;
        }
        text = text.replace(/__ENC:[A-Za-z0-9+/=]+__/g, PLACEHOLDER_TEXT);
        data = Buffer.from(text, 'utf8');
      }
      // profile 清单：收敛依赖写法，避免快照往本机注入任意包
      if (isProfileManifest(item.target, plan.paths)) {
        try {
          const parsed = JSON.parse(data.toString('utf8'));
          const { manifest, dropped } = sanitizeProfileManifest(parsed);
          if (dropped.length) sanitized.push({ path: item.path, dropped });
          data = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        } catch {
          skippedManifests.push(item.path);
          continue;
        }
      }
      fs.mkdirSync(path.dirname(item.target), { recursive: true });
      fs.writeFileSync(item.target, data);
      written++;
    }
  } catch (err) {
    rollback(undo);
    throw new Error(`恢复失败并已回滚：${err.message}`);
  }

  const relinked = relinkPlugins(plan, { backupDir, ...(plan.paths ?? {}) });
  return { written, backupDir, relinked, decrypted, decryptFailed, sanitized, skippedManifests, rollback: () => rollback(undo) };
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
