# dsh-cloud-sync

把 DSH 的可移植配置备份 / 同步到**任意 WebDAV**（默认坚果云，也兼容 Nextcloud、群晖、ownCloud、AList），零第三方依赖。

## 安装

DSH 的插件市场是「索引源」模式，**没有全网搜索**：别人要用，需要把这个索引地址加进去，然后在市场里搜「云同步」。

**方式一：加索引源（推荐）**

1. DSH 打开 插件 → 发现 → 索引源 → 添加
2. 粘贴：

   ```text
   https://raw.githubusercontent.com/doraasn/dsh-plugins-index/main/market-index.json
   ```

3. 选中该市场，搜「云同步」或 `cloud-sync`，点安装。

> 该索引同时收录 doraasn 名下的其他 DSH 插件（额度看板、Web Chat、移动访问设置）。

**方式二：命令行直接装（git）**

```powershell
dsh plugin --profile desktop add "git+https://github.com/doraasn/dsh-cloud-sync.git#7c98449c892c857d190422b8b6e594241ea83a99"
```

装完把 `dsh-cloud-sync` 加进该 profile `package.json` 的 `dsh.profile.bundles`，再重启 DSH（`install.ps1` 会自动做这两步）。

> 尚未发布到 npm（`dsh-cloud-sync` 这个名字在 npm 上已被占用），所以走 git 源。索引统一维护在 [dsh-plugins-index](https://github.com/doraasn/dsh-plugins-index)，本仓库不再放 `market-index.json`。

## 同步什么

| 段落 | 来源 | 归档内前缀 |
|---|---|---|
| `skills` | `$DSH_HOME/skills` | `skills/` |
| `agentsSkills` | `$DSH_AGENTS_HOME`（默认 `~/.agents`）`/skills` | `agents-skills/` |
| `mcp` | `$DSH_HOME/profiles/<profile>/` 下的 `cordis.patch.yml`（含 DSH 全局设置：模型 provider、权限预设、主题偏好）、`cordis.yml`、`package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml` | `mcp/` |
| `plugins` | profile 里所有 `link:` 依赖指向的插件源码（跳过 `node_modules`、`dist`） | `plugins/<包名>/` |
| `instructions` | `$DSH_HOME/AGENTS.md`、`~/.agents/AGENTS.md` | `instructions/` |
| 模型凭据 | `$DSH_HOME/.credentials.yaml`（需显式开启，加密后进包） | `secrets/.credentials.yaml.enc` |

**会话历史、附件、`dsh-runtimes`、`node_modules`、`storages` 缓存永不进包。**

## 安全模型

- 默认**不含任何明文密钥**：`Authorization: Bearer xxx` 一律打码成 `Bearer __SECRET__`，`mcp/`、`.env`、`*credential*` 里的 `key = value` 也只在值"像真密钥"时打码（长度 ≥ 16、无 `$ % < {`）。
- 处理过的位置记在 `manifest.json` 的 `placeholders` 里（含 `encrypted` 标记），`/csync pull` 会说明「已还原 N 处」或「需重填 N 处」。
- **恢复保护**：没有口令解不开的 `__ENC__` 令牌、或只有 `__SECRET__` 占位符时，若本地已有真实密钥就判为"密钥保护跳过"，**不会覆盖**本地真值（计划里以 `!` 标记）。
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

应用密码按服务生成：坚果云在「账户信息」的「安全选项」里新增「第三方应用管理」的应用密码；Nextcloud 在「设置」的「安全」里生成「设备专用密码」；群晖用账号密码或应用专用密码。

## 图形设置卡片

装好后在「设置」里打开 **云同步**（`settings.section` 插槽）。卡片分四组：

| 分组 | 内容 |
|---|---|
| 连接 | WebDAV 地址、账号、应用密码（+「保存」写入凭据槽）、远端目录 |
| 备份内容 | 六个开关，见下表；勾选即保存 |
| 动作 | 立即上传、预览备份内容、预览恢复 |
| 远端快照 | 每份快照的名称 / 大小 / 时间，逐条「预览恢复」 |

「备份内容」各开关对应的实际路径：

| 开关 | 内容 | 路径 |
|---|---|---|
| 本机技能（~/.dsh） | DSH 自有技能 | `$DSH_HOME/skills` |
| 共享技能（~/.agents） | 多个工具共用的技能目录 | `$DSH_AGENTS_HOME/skills`（默认 `~/.agents/skills`） |
| DSH 配置与插件清单 | DSH 全局设置（模型 provider、权限预设、主题偏好）、插件与 MCP 条目、锁文件 | `profiles/<name>/` 下的 `cordis.patch.yml`、`cordis.yml`、`package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml` |
| 本地插件源码（link） | `link:` 依赖指向的插件源码（market 插件可从 registry 重装，不必打包） | 各 `link:` 目标目录 |
| 全局指令（AGENTS.md） | 每次会话都会读取的全局指令 | `$DSH_HOME/AGENTS.md`、`$DSH_AGENTS_HOME/AGENTS.md` |
| 模型凭据（加密） | 各模型 provider 的 API key | `$DSH_HOME/.credentials.yaml`（加密后进包） |

动作区：**立即上传**（主按钮）、**预演打包**、**刷新快照**、**预演最新快照恢复**；恢复必须先预演，预演结果里再点「确认恢复到本地」。

上传/恢复进行中会显示阶段与计时（依次为：正在收集文件、正在打包与校验、正在上传到云端、正在清理旧快照），期间按钮全部禁用；结束后用结构化卡片给出快照名、大小、文件数、耗时、各段落统计、跳过的大文件与占位符提示。

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
