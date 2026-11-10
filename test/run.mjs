/**
 * 自测：临时 DSH_HOME、不联网、不碰真实 ~/.dsh。
 * 覆盖三件事：归档路径越界、HTTP 路由守卫、push 口令兜底。
 * 用法: npm test
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cloud-sync-test-'))
process.env.DSH_HOME = HOME
fs.mkdirSync(path.join(HOME, 'storages'), { recursive: true })

const { localPathFor } = await import(new URL('../lib/restore.js', import.meta.url).href)
const { registerRoutes } = await import(new URL('../lib/index.js', import.meta.url).href)

let passed = 0
let failed = 0
const check = (name, condition, extra = '') => {
  if (condition) passed++
  else {
    failed++
    console.log(`  FAIL  ${name}${extra ? '  ' + extra : ''}`)
  }
}

// ---- 1. 归档路径映射：正常段落仍要能用 ----
const roots = { dshHome: path.join(HOME, 'dsh'), agentsHome: path.join(HOME, 'agents'), profile: 'desktop' }
check('skills 正常映射', localPathFor('skills/foo/SKILL.md', roots) === path.join(HOME, 'dsh', 'skills', 'foo', 'SKILL.md'))
check('instructions 正常映射', localPathFor('instructions/AGENTS.md', roots) === path.join(HOME, 'dsh', 'AGENTS.md'))
check('mcp 带 profile', localPathFor('mcp/cordis.patch.yml', roots) === path.join(HOME, 'dsh', 'profiles', 'desktop', 'cordis.patch.yml'))
check('plugins 落 local-plugins', localPathFor('plugins/x/lib/index.js', roots) === path.join(HOME, 'dsh', 'local-plugins', 'x', 'lib', 'index.js'))
check('未知段落返回 null', localPathFor('secrets/x', roots) === null)
check('空尾部返回 null', localPathFor('skills', roots) === null)

// ---- 2. 路径穿越必须判为「不归我管」 ----
const escapes = [
  'skills/../../evil.txt',
  'skills/../../../Windows/System32/drivers/etc/hosts',
  'instructions/../../evil.md',
  'plugins/../../../x.js',
  'local-plugins/a/../../../../evil.js',
  'storages/..\\..\\evil.json',
]
for (const entry of escapes) {
  check(`越界被拒: ${entry}`, localPathFor(entry, roots) === null, `实际 ${localPathFor(entry, roots)}`)
}
// 带盘符的段（archivePath 里的 "C:"）会被 Node 当成驱动器相对路径，结果仍落在根内，不能逃逸。
const driveEntry = localPathFor('instructions/C:/Windows/win.ini', roots)
check('带盘符段不逃逸根目录',
  driveEntry === null || path.resolve(driveEntry).startsWith(path.resolve(roots.dshHome) + path.sep),
  `实际 ${driveEntry}`)

// ---- 3. HTTP 路由守卫 ----
const SELF_ORIGIN = 'http://127.0.0.1:59681'
const HOST = '127.0.0.1:59681'
let handler = null
const ctx = {
  webServer: { register: (route) => { handler = route.handler; return () => {} }, getOrigin: () => SELF_ORIGIN },
  get: () => undefined,
}
registerRoutes(ctx)

const call = (url, method = 'GET', body = null, headers = { host: HOST }) => new Promise((resolve) => {
  const listeners = {}
  const req = {
    url,
    method,
    headers,
    on(event, cb) { listeners[event] = cb },
    async *[Symbol.asyncIterator]() { if (body !== null) yield Buffer.from(body) },
  }
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { res.headers[name] = value },
    end(text) {
      let parsed = null
      try { parsed = JSON.parse(text) } catch { parsed = text }
      resolve({ status: res.statusCode, body: parsed })
    },
  }
  handler(req, res)
})

check('正常 Host 放行（未知路由 404）', (await call('/cloud-sync/api/nope')).status === 404)
const rebind = await call('/cloud-sync/api/state', 'GET', null, { host: 'evil.example' })
check('伪造 Host 被拒', rebind.status === 403 && rebind.body.text === 'forbidden-host', JSON.stringify(rebind.body))
const csrfOrigin = await call('/cloud-sync/api/action', 'POST', '{"command":"list"}', { host: HOST, origin: 'https://evil.example' })
check('跨站 Origin 被拒', csrfOrigin.status === 403 && csrfOrigin.body.text === 'forbidden-origin', JSON.stringify(csrfOrigin.body))
check('Origin: null 被拒', (await call('/cloud-sync/api/action', 'POST', '{}', { host: HOST, origin: 'null' })).status === 403)
check('超大 body 返回 413', (await call('/cloud-sync/api/action', 'POST', 'x'.repeat(70 * 1024), { host: HOST, origin: SELF_ORIGIN })).status === 413)

// ---- 4. push 口令兜底不再引用未定义变量 ----
const syncSource = fs.readFileSync(new URL('../lib/sync.js', import.meta.url), 'utf8')
check('push 不再直接引用裸 password', !/\?\?\s*password\b/.test(syncSource))
check('push 自己解析 passwordRef', /resolvePassword\(credentials,\s*config\.passwordRef\)/.test(syncSource))

// ---- 5. 配置写入白名单 ----
const { validateConfigPatch } = await import(new URL('../lib/actions.js', import.meta.url).href)
const throws = (fn) => {
  try { fn(); return false } catch { return true }
}
check('拒绝未知配置键', throws(() => validateConfigPatch('passwordRef', 'X')))
check('拒绝非 http(s) baseUrl', throws(() => validateConfigPatch('baseUrl', 'file:///c:/x')))
check('拒绝含 .. 的 remoteDir', throws(() => validateConfigPatch('remoteDir', 'a/../b')))
check('keep 夹取到区间内', validateConfigPatch('keep', 9999) === 50)
check('autoSyncMode 白名单', throws(() => validateConfigPatch('autoSyncMode', 'always')))

// ---- 6. 改地址必须重新绑定口令（凭据按 host 绑定）----
const { runSubcommand } = await import(new URL('../lib/actions.js', import.meta.url).href)
const { loadConfig } = await import(new URL('../lib/config.js', import.meta.url).href)
const { createClient } = await import(new URL('../lib/sync.js', import.meta.url).href)
const credentialsCtx = { get: (name) => (name === 'credentials' ? undefined : undefined) }

const before = loadConfig()
check('初始 credentialHost 跟随默认地址', before.credentialHost === 'dav.jianguoyun.com', `实际 ${before.credentialHost}`)

const changed = await runSubcommand(credentialsCtx, ['config', 'baseUrl', 'https://evil.example/dav/'])
check('改 baseUrl 成功', changed.kind === 'success')
check('换 host 后清空口令绑定', loadConfig().credentialHost === '', `实际 ${JSON.stringify(loadConfig().credentialHost)}`)

let refused = ''
try {
  await createClient(credentialsCtx, { ...loadConfig(), username: 'u@example.com' })
} catch (error) {
  refused = String(error?.message ?? error)
}
check('未重新设置口令时拒绝出网', /重新执行 \/csync secret/.test(refused), `实际 ${refused}`)

// ---- 7. secret-ref 不能写别人的凭据槽 ----
const foreign = await runSubcommand(credentialsCtx, ['secret-ref', 'DEEPSEEK_API_KEY', 'sk-test'])
check('拒绝写外部凭据槽', foreign.kind === 'error' && /拒绝写入/.test(foreign.text), foreign.text)

// ---- 8. 归档条目必须与 manifest 一致 ----
const { packTarGz } = await import(new URL('../lib/tar.js', import.meta.url).href)
const { openBundle } = await import(new URL('../lib/bundle.js', import.meta.url).href)
const sneaky = packTarGz([
  { path: 'manifest.json', data: Buffer.from(JSON.stringify({ files: [] })) },
  { path: 'instructions/../../evil.md', data: Buffer.from('pwn') },
])
let bundleError = ''
try { openBundle(sneaky) } catch (error) { bundleError = String(error?.message ?? error) }
check('未声明条目被拒', /未在 manifest 声明/.test(bundleError), `实际 ${bundleError}`)

// ---- 9. 状态下发不带凭据槽名 ----
const { stateSnapshot } = await import(new URL('../lib/actions.js', import.meta.url).href)
const snapshot = await stateSnapshot({ get: () => undefined })
check('state 不含 passwordRef', !('passwordRef' in snapshot.config))
check('state 不含 secretPasswordRef', !('secretPasswordRef' in snapshot.config))
check('state 仍保留设置页要用的字段', ['baseUrl', 'username', 'remoteDir', 'sections'].every((key) => key in snapshot.config))

fs.rmSync(HOME, { recursive: true, force: true })
console.log(`\n结果: ${passed} 通过 / ${failed} 失败`)
process.exitCode = failed === 0 ? 0 : 1
