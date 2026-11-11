/**
 * 插件配置与路径解析。
 *
 * 刻意不 import 任何 @deepseek-ai/* 库：第三方 link: 插件能否在运行态解析官方包
 * 未经验证，所以 DSH_HOME / agentsHome 走环境变量 + 默认值，配置存在自己的
 * JSON 文件里，凭据优先用宿主 credentials 服务（服务通过 ctx 注入，不涉及模块解析）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME?.trim();
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), '.dsh');
}

export function resolveAgentsHome() {
  const fromEnv = process.env.DSH_AGENTS_HOME?.trim();
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), '.agents');
}

export function resolveProfileName() {
  const fromEnv = process.env.DSH_PROFILE?.trim();
  return fromEnv || 'desktop';
}

export const DEFAULT_CONFIG = {
  /** 坚果云 WebDAV 根地址（含 /dav/） */
  baseUrl: 'https://dav.jianguoyun.com/dav/',
  /** WebDAV 登录邮箱或用户名 */
  username: '',
  /** 凭据槽名：口令从这里读，不落配置文件 */
  passwordRef: 'CLOUD_SYNC_PASSWORD',
  /** 远端子目录 */
  remoteDir: 'dsh-sync',
  /** 同步段落 */
  sections: ['skills', 'agentsSkills', 'mcp', 'plugins', 'instructions', 'storages', 'memories', 'localPlugins', 'skillLock', 'profiles'],
  /** 额外排除的 glob（相对 section 内路径） */
  exclude: [],
  /** 是否把 skills 下的二进制/工具目录排除掉（mysql 客户端那 30MB） */
  excludeBinaries: true,
  /** 远端保留份数（内部默认，界面上不暴露） */
  keep: 5,
  /** 是否把 .credentials.yaml 一并打包 */
  includeSecrets: false,
  /** 打包密钥时使用的口令槽名（scrypt + AES-256-GCM） */
  secretPasswordRef: 'CLOUD_SYNC_SECRET_PASSWORD',
  /** 上传失败后的重试间隔（分钟）：避免每个轮询周期都重新打包再失败 */
  retryMinutes: 60,
  /** 单次上传的空闲超时（毫秒）：坚果云限速时大包中途可能长时间没有数据流动 */
  uploadTimeoutMs: 300000,
  /** 自动同步模式：off = 关闭，interval = 定时，watch = 检测到改动后 */
  autoSyncMode: 'off',
  /** 定时模式间隔（分钟） */
  autoSyncMinutes: 60,
  /** 改动模式防抖窗口（秒）：窗口内的多次改动只推一次 */
  autoSyncDebounceSeconds: 90,
  /** 只在全量备份里出现的段落（体积大、可从来源重装） */
  fullOnlySections: ['skills', 'agentsSkills'],
  /** 全量备份周期（分钟），默认 7 天；0 = 不自动做全量 */
  fullSyncMinutes: 10080,
  /** 旧版字段：小时级间隔，仅在 autoSyncMode 未设置时用于迁移 */
  autoSyncHours: 0,
};

export function configPath(dshHome = resolveDshHome()) {
  return path.join(dshHome, 'cloud-sync', 'config.json');
}

/**
 * 口令绑定的主机：WebDAV 应用密码只允许发给「设置它时那个 host」。
 * 否则改一次 baseUrl 就能让宿主把 Basic 口令主动发给新地址。
 */
export function hostOf(baseUrl) {
  try {
    return new URL(String(baseUrl)).host.toLowerCase();
  } catch {
    return '';
  }
}

export function statePath(dshHome = resolveDshHome()) {
  return path.join(dshHome, 'cloud-sync', 'state.json');
}

export function loadConfig(dshHome = resolveDshHome()) {
  const file = configPath(dshHome);
  let stored = {};
  if (fs.existsSync(file)) {
    try {
      stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`配置文件损坏 ${file}：${err.message}`);
    }
  }
  const merged = { ...DEFAULT_CONFIG, ...stored };
  // 旧配置没有 credentialHost：首次加载时按当前地址补上（一次性迁移）。
  // 之后改地址会把 credentialHost 清空，必须重新 /csync secret，不再自动绑定。
  if (typeof merged.credentialHost !== 'string') merged.credentialHost = hostOf(merged.baseUrl);
  return merged;
}

export function saveConfig(patch, dshHome = resolveDshHome()) {
  const file = configPath(dshHome);
  const next = { ...loadConfig(dshHome), ...patch };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

export function loadState(dshHome = resolveDshHome()) {
  const file = statePath(dshHome);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function saveState(patch, dshHome = resolveDshHome()) {
  const file = statePath(dshHome);
  const next = { ...loadState(dshHome), ...patch };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

/**
 * 解析 WebDAV 口令：优先宿主 credentials 服务，其次进程环境变量。
 * 返回值不写日志、不进归档。
 */
export async function resolvePassword(credentials, ref) {
  if (credentials?.resolve) {
    try {
      const found = await credentials.resolve(ref);
      if (found?.value) return found.value;
    } catch {
      /* 服务不可用时静默降级到环境变量 */
    }
  }
  const fromEnv = process.env[ref]?.trim();
  return fromEnv || null;
}

/**
 * 日常档范围：从 sections 里去掉只在全量档出现的段落。
 * 放在 config.js 里是为了让 sync.js 与 autosync.js 都能用，避免二者循环依赖。
 */
export function dailyScopeConfig(config) {
  const fullOnly = new Set(config.fullOnlySections ?? []);
  const sections = (config.sections ?? []).filter((name) => !fullOnly.has(name));
  return { ...config, sections };
}
