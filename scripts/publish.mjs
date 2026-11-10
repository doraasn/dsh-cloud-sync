/**
 * 发版收尾脚本：把「推送」这一步固化，避免 tag 停在本机。
 *
 * 用法：
 *   node scripts/publish.mjs            校验 + 推送 main 与当前 HEAD 的 tag + 远端复核
 *   node scripts/publish.mjs --dry-run  只校验与打印将要执行的推送，不实际推送
 *
 * 退出码 1 表示自检失败或推送后复核不一致，可直接作为发版流程的门禁。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const dryRun = process.argv.includes('--dry-run');

const git = (args, env) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: env ?? process.env }).trim();

/** 用 ~/.gitconfig 的身份与凭据，绕开 superagent 注入的 worker-gitconfig。 */
const cleanEnv = () => {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: `${process.env.USERPROFILE}\\.gitconfig` };
  delete env.GIT_CONFIG_NOSYSTEM;
  return env;
};

const problems = [];
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
const head = git(['rev-parse', 'HEAD']);

/* ---------- 1. 身份自检 ---------- */
if (!/^\d+\.\d+\.\d+$/.test(String(pkg.version ?? ''))) problems.push(`version 异常：${pkg.version}`);
if (!pkg.files?.length) problems.push('files 缺失');
if (!pkg.exports?.['./icon']) problems.push('./icon 导出缺失');
if (pkg.dependencies && Object.keys(pkg.dependencies).length) problems.push(`插件不应有 dependencies：${JSON.stringify(pkg.dependencies)}`);

const tag = git(['describe', '--tags', '--exact-match', 'HEAD'], cleanEnv()).toString();
if (!tag) problems.push('HEAD 没有 tag，先打 v<version>');
else if (tag !== `v${pkg.version}`) problems.push(`tag ${tag} ≠ version ${pkg.version}`);

if (git(['status', '--porcelain'])) problems.push('工作区有未提交文件');

if (problems.length) {
  console.error(`自检未通过（版本 ${pkg.version}，HEAD ${head.slice(0, 7)}）：`);
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

/* ---------- 2. 推送 ---------- */
const env = cleanEnv();
const remoteMain = git(['ls-remote', '--heads', 'origin', 'main'], env).split(/\s+/)[0] ?? '';
const aheadOfRemote = remoteMain !== head;

console.log(`版本 ${pkg.version}｜tag ${tag}｜HEAD ${head.slice(0, 7)}｜远端 main ${remoteMain.slice(0, 7) || '(空)'}`);

if (!aheadOfRemote) {
  const remoteTag = git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}^{}`], env);
  if (remoteTag.includes(head)) {
    console.log('远端已是最新，无需推送。');
    process.exit(0);
  }
}

if (dryRun) {
  console.log(`将执行：git push origin main ${tag}`);
  process.exit(0);
}

try {
  execFileSync('git', ['push', 'origin', 'main', tag], { cwd: repo, env, stdio: 'inherit' });
} catch {
  console.error(`推送失败：先设置凭据（git config credential.helper <path>），再重跑本脚本。`);
  process.exit(1);
}

/* ---------- 3. 远端复核 ---------- */
const afterMain = git(['ls-remote', '--heads', 'origin', 'main'], env).split(/\s+/)[0] ?? '';
const afterTag = git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}^{}`], env);
if (afterMain !== head) {
  console.error(`复核失败：远端 main ${afterMain.slice(0, 7)} ≠ 本地 ${head.slice(0, 7)}`);
  process.exit(1);
}
if (!afterTag.includes(head)) {
  console.error(`复核失败：远端 ${tag} 未指向 ${head.slice(0, 7)}`);
  process.exit(1);
}
console.log(`已推送并复核：main 与 ${tag} 都指向 ${head.slice(0, 7)}。`);
