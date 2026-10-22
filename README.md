# dsh-cloud-sync

把 DSH 的可移植配置备份 / 同步到**任意 WebDAV**（默认坚果云，也兼容 Nextcloud、群晖、ownCloud、AList），零第三方依赖。

## 同步什么

| 段落 | 来源 | 归档内前缀 |
|---|---|---|
| `skills` | `$DSH_HOME/skills` | `skills/` |
| `agentsSkills` | `$DSH_AGENTS_HOME`（默认 `~/.agents`）`/skills` | `agents-skills/` |
| `mcp` | `$DSH_HOME/profiles/<profile>/{cordis.patch.yml,package.json,pnpm-workspace.yaml}` | `mcp/` |
| `instructions` | `$DSH_HOME/AGENTS.md`、`~/.agents/AGENTS.md` | `instructions/` |
| `storages` | `$DSH_HOME/storages`（默认不含 `session_projcache`） | `storages/` |
| 密钥 | `$DSH_HOME/.credentials.yaml`（需显式开启，加密后进包） | `secrets/.credentials.yaml.enc` |

**会话历史、附件、`dsh-runtimes` 永不进包。**

## 安全模型

- 默认**不含任何明文密钥**：`Authorization: Bearer xxx` 一律打码成 `Bearer __SECRET__`，`mcp/`、`.env`、`*credential*` 里的 `key = value` 也只在值"像真密钥"时打码（长度 ≥ 16、无 `$ % < {`）。
- 处理过的位置记在 `manifest.json` 的 `placeholders` 里（含 `encrypted` 标记），`/csync pull` 会说明「已还原 N 处」或「需重填 N 处」。
- **恢复保护**：没有口令解不开的 `__ENC__` 令牌、或只有 `__SECRET__` 占位符时，若本地已有真实密钥就判为"密钥保护跳过"，**不会覆盖**本地真值（计划里显示 `🔒`）。
- 开启 `includeSecrets` 时，`.credentials.yaml` 以 **scrypt + AES-256-GCM** 密文进包，口令来自凭据槽 `CLOUD_SYNC_SECRET_PASSWORD`，不落任何文件。
- 默认排除 `**/node_modules/**`、`**/.git/**`、`*.exe/*.dll/...`；单文件默认不设上限。

## 安装（必须先完全退出 DSH）

```powershell
# 1. 托盘退出 DSH（确认任务管理器里没有 DeepSeek Harness 进程）
# 2. 在插件目录执行安装脚本（脚本按 UTF-8 BOM 保存，适配 Windows PowerShell 5.1）
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
# 3. 重新打开 DSH
# 4. 自检（可开着 DSH 跑）
powershell -NoProfile -ExecutionPolicy Bypass -File .\verify.ps1
```

## 首次配置

在任意会话里：

```text
/csync secret <WebDAV 应用密码>         # 写入 DSH 凭据槽，不落配置文件
/csync config username 你的邮箱@example.com
/csync status                          # 看连通性与远端快照
/csync push --dry-run                  # 先看会打包什么，不上传
/csync push                            # 真正上传
```

应用密码按服务生成：坚果云「账户信息 → 安全选项 → 第三方应用管理 → 添加应用密码」；Nextcloud「设置 → 安全 → 设备专用密码」；群晖用账号密码或应用专用密码。

## 图形设置卡片

装好后打开 **设置 → 云同步**（`settings.section` 插槽）。卡片分三组：

| 分组 | 内容 |
|---|---|
| 连接 | WebDAV 地址、账号、应用密码（+「保存密码」写入凭据槽） |
| 同步范围 | 段落、远端目录、是否加密备份凭据；改完自动保存 |
| 远端快照 | 每份快照的 名称 / 大小 / 时间，逐条「预演恢复」 |

动作区：**立即上传**（主按钮）、**预演打包**、**刷新快照**、**预演最新快照恢复**；恢复必须先预演，预演结果里再点「确认恢复到本地」。

上传/恢复进行中会显示阶段与计时（`正在收集文件 → 正在打包与校验 → 正在上传到云端 → 正在清理旧快照`），期间按钮全部禁用；结束后用结构化卡片给出快照名、大小、文件数、耗时、各段落统计、跳过的大文件与占位符提示。

卡片与命令走同一份实现（`lib/actions.js`），因此两端行为一致。宿主暴露的接口：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/cloud-sync/api/state` | 配置（脱敏）、凭据槽状态、远端快照、上次推送、当前进度 |
| POST | `/cloud-sync/api/action` | `{ args: ["push"] }` 形式的子命令调用 |

## 命令

| 命令 | 作用 |
|---|---|
| `/csync` / `/csync status` | 配置、凭据槽、远端快照、上次推送总览 |
| `/csync config` | 打印全部配置 |
| `/csync config <键> <值>` | 改一项（值支持 JSON，例如 `sections '["skills","mcp"]'`） |
| `/csync secret <口令>` | 写入凭据槽 |
| `/csync push [--dry-run]` | 打包并上传，附带保留策略清理 |
| `/csync list` | 列远端快照 |
| `/csync diff [快照名]` | 下载并预演恢复计划（零写入） |
| `/csync pull [快照名] --yes` | 真正落盘恢复（先自动备份，失败回滚） |
| `/csync prune` | 按保留份数清理远端 |

## 配置键

| 键 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `https://dav.jianguoyun.com/dav/` | WebDAV 根地址 |
| `username` | 空 | WebDAV 登录邮箱或用户名 |
| `passwordRef` | `CLOUD_SYNC_PASSWORD` | 口令所在的凭据槽名 |
| `remoteDir` | `dsh-sync` | 远端目录（相对 `baseUrl`） |
| `sections` | `skills,agentsSkills,mcp,instructions` | 同步段落 |
| `exclude` | `[]` | 额外 glob 排除，如 `["artifact-template-*/**/assets/**"]` |
| `excludeBinaries` | `true` | 排除 exe/dll/压缩包等 |
| `maxFileBytes` | 0 | 单文件上限，0 = 不限 |
| `keep` | 5 | 远端保留份数（界面不暴露，prune 用） |
| `includeSecrets` | `false` | 是否打包 `.credentials.yaml`（加密） |
| `secretPasswordRef` | `CLOUD_SYNC_SECRET_PASSWORD` | 加密口令槽 |
| `redact` | `true` | 是否打码明文密钥（关掉则按原样进包） |
| `autoSyncHours` | 0 | 定时自动推送间隔（小时），0 = 关闭；失败只记日志不打断会话 |

## 故障与回滚

- **DSH 起不来**：启动失败弹窗第 3 个按钮「禁用第三方插件、备份 profile patch 并重启」。
- **卸载**：退出 DSH 后执行 `uninstall.ps1`，或手工从 `~/.dsh/profiles/desktop/package.json` 删掉依赖与 `dsh.profile.bundles` 里的 `dsh-cloud-sync`。
- **恢复失败**：`applyRestore` 会自动回滚；恢复前的原件复制在 `$DSH_HOME/cloud-sync/backup-<时间戳>/`。

## 已知限制

1. 密钥是否需要手填取决于口令：有口令则 `__ENC__` 令牌在恢复时自动还原；无口令则为 `__SECRET__`，需按提示重填。
2. 单文件默认不设上限；WebDAV 服务端通常限制单文件 500 MB，超过仍需用 `exclude` 排除。
3. 图形卡片挂在设置分区 `settings.section`；若该插槽在你的 profile 里不可用，会退化为侧栏底部入口。
4. 恢复技能与 MCP 后需要重启 DSH 才完全生效。
