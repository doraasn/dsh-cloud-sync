/**
 * 采集要同步的 DSH 配置：技能、共享技能、MCP/profile 行、全局指令、storages、凭据。
 *
 * 归档内的路径布局：
 *   manifest.json
 *   skills/<技能名>/...
 *   agents-skills/<技能名>/...
 *   mcp/<profile 配置文件>
 *   instructions/AGENTS.md
 *   storages/<文件名>
 *   secrets/.credentials.yaml（仅在显式开启时）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveAgentsHome, resolveDshHome, resolveProfileName } from './config.js';

const BINARY_EXCLUDES = ['**/node_modules/**', '**/.git/**', '**/*.exe', '**/*.dll', '**/*.so', '**/*.dylib', '**/*.zip', '**/*.tar.gz'];

/** 极简 glob：支持 ** 、* 、?（路径以 / 分隔）。 */
export function matchGlob(pattern, value) {
  // 逐字符转换，避免先插入的正则片段被后续 replace 二次改写
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') {
          i++;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`).test(value);
}

function isExcluded(relative, patterns) {
  return patterns.some((pattern) => matchGlob(pattern, relative));
}

function walkDir(root, { prefix, exclude, acc, warnings }) {
  if (!fs.existsSync(root)) {
    warnings.push(`跳过（不存在）：${root}`);
    return;
  }
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const abs = path.join(root, rel);
    let items;
    try {
      items = fs.readdirSync(abs, { withFileTypes: true });
    } catch (err) {
      warnings.push(`读取失败（跳过）：${abs} — ${err.message}`);
      continue;
    }
    for (const item of items) {
      const childRel = rel ? `${rel}/${item.name}` : item.name;
      const childAbs = path.join(abs, item.name);
      if (item.isSymbolicLink()) {
        warnings.push(`跳过符号链接：${childRel}`);
        continue;
      }
      if (item.isDirectory()) {
        if (isExcluded(childRel, exclude) || isExcluded(`${childRel}/`, exclude)) continue;
        stack.push(childRel);
        continue;
      }
      if (!item.isFile()) continue;
      if (isExcluded(childRel, exclude)) continue;
      try {
        const stat = fs.statSync(childAbs);
        acc.push({ archivePath: `${prefix}/${childRel}`, absPath: childAbs, bytes: stat.size, mtimeMs: Math.floor(stat.mtimeMs) });
      } catch (err) {
        warnings.push(`stat 失败（跳过）：${childRel} — ${err.message}`);
      }
    }
  }
}

function collectFiles(root, prefix, patterns, acc, warnings, maxFileBytes = 0, skipped = null) {
  const before = acc.length;
  walkDir(root, { prefix, exclude: patterns, acc, warnings });
  for (let i = acc.length - 1; i >= before; i--) {
    if (maxFileBytes > 0 && acc[i].bytes > maxFileBytes) {
      const dropped = acc.splice(i, 1)[0];
      skipped?.push({ path: dropped.archivePath, bytes: dropped.bytes });
    }
  }
}

/**
 * 采集所有启用段落的文件清单（不读内容，只登记路径与大小）。
 * @returns {{files: Array, warnings: string[], counts: Record<string, number>}}
 */
export function collectSections(config, paths = {}) {
  const dshHome = paths.dshHome ?? resolveDshHome();
  const agentsHome = paths.agentsHome ?? resolveAgentsHome();
  const profile = paths.profile ?? resolveProfileName();
  const files = [];
  const warnings = [];
  const counts = {};
  const skipped = [];
  const sections = new Set(config.sections ?? []);
  const maxFileBytes = Number(config.maxFileBytes ?? 0);

  const baseExclude = [...(config.exclude ?? [])];
  if (config.excludeBinaries) baseExclude.push(...BINARY_EXCLUDES);

  const add = (section, list) => {
    counts[section] = (counts[section] ?? 0) + list.length;
  };

  if (sections.has('skills')) {
    const before = files.length;
    collectFiles(path.join(dshHome, 'skills'), 'skills', baseExclude, files, warnings, maxFileBytes, skipped);
    add('skills', files.slice(before));
  }
  if (sections.has('agentsSkills')) {
    const before = files.length;
    collectFiles(path.join(agentsHome, 'skills'), 'agents-skills', baseExclude, files, warnings, maxFileBytes, skipped);
    add('agentsSkills', files.slice(before));
  }
  if (sections.has('mcp')) {
    const profileDir = path.join(dshHome, 'profiles', profile);
    const candidates = ['cordis.patch.yml', 'cordis.yml', 'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml'];
    const before = files.length;
    for (const name of candidates) {
      const abs = path.join(profileDir, name);
      if (!fs.existsSync(abs)) {
        warnings.push(`MCP/配置段缺少 ${name}（跳过）`);
        continue;
      }
      const stat = fs.statSync(abs);
      files.push({ archivePath: `mcp/${name}`, absPath: abs, bytes: stat.size, mtimeMs: Math.floor(stat.mtimeMs), profile });
    }
    add('mcp', files.slice(before));
  }
  if (sections.has('plugins')) {
    // link: 本地插件的源码目录（node_modules/.git 已在 baseExclude 里）
    const profileDir = path.join(dshHome, 'profiles', profile);
    const manifestPath = path.join(profileDir, 'package.json');
    if (!fs.existsSync(manifestPath)) {
      warnings.push('插件段：找不到 profile package.json（跳过）');
    } else {
      const before = files.length;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
          if (typeof spec !== 'string' || !spec.startsWith('link:')) continue;
          const target = path.resolve(profileDir, spec.slice(5));
          if (!fs.existsSync(target)) {
            warnings.push(`插件段：${name} 的 link 目标不存在（跳过）：${target}`);
            continue;
          }
          collectFiles(target, `plugins/${name}`, [...baseExclude, 'dist/**'], files, warnings, maxFileBytes, skipped);
        }
      } catch (err) {
        warnings.push(`插件段：解析 package.json 失败（跳过）：${err.message}`);
      }
      add('plugins', files.slice(before));
    }
  }
  if (sections.has('instructions')) {
    const before = files.length;
    for (const [root, prefix] of [[dshHome, 'instructions'], [agentsHome, 'instructions-agents']]) {
      const abs = path.join(root, 'AGENTS.md');
      if (!fs.existsSync(abs)) continue;
      const stat = fs.statSync(abs);
      files.push({ archivePath: `${prefix}/AGENTS.md`, absPath: abs, bytes: stat.size, mtimeMs: Math.floor(stat.mtimeMs) });
    }
    add('instructions', files.slice(before));
  }
  if (sections.has('storages')) {
    const before = files.length;
    collectFiles(path.join(dshHome, 'storages'), 'storages', [...baseExclude, 'session_projcache/**'], files, warnings, maxFileBytes, skipped);
    add('storages', files.slice(before));
  }
  if (config.includeSecrets) {
    const before = files.length;
    const abs = path.join(dshHome, '.credentials.yaml');
    if (fs.existsSync(abs)) {
      const stat = fs.statSync(abs);
      files.push({ archivePath: 'secrets/.credentials.yaml', absPath: abs, bytes: stat.size, mtimeMs: Math.floor(stat.mtimeMs), secret: true });
    } else {
      warnings.push('.credentials.yaml 不存在（跳过 secrets 段）');
    }
    counts.secrets = files.length - before;
  }

  return { files, warnings, counts, skipped, dshHome, agentsHome, profile };
}

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 读文件内容并算 sha256，组装 manifest 条目。 */
export function readEntries(files) {
  return files.map((file) => {
    const data = fs.readFileSync(file.absPath);
    return { path: file.archivePath, data, bytes: data.length, sha256: sha256(data), secret: Boolean(file.secret) };
  });
}
