/**
 * dsh-cloud-sync · 客户端半区（Web）
 *
 * 设置里的「云同步」分区。布局照 DSH 原生设置页的「行」模式：
 * 左侧标题 + 说明，右侧控件，行间用 --dsw-alias-border-l2 分隔线。
 */
window.__ModuleLoader__.load({
  id: 'dsh-cloud-sync',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const API = '/cloud-sync/api';
    const POLL_MS = 700;

    // —— 与原生设置页一致的取值 ——
    const wrap = { display: 'flex', flexDirection: 'column', color: 'var(--dsw-alias-label-primary)' };
    const sectionTitle = { margin: '0 0 4px', fontSize: 16, fontWeight: 500, lineHeight: '24px' };
    const hint = { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' };
    const rowTitle = { fontSize: 14, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)' };
    const input = {
      boxSizing: 'border-box', width: '100%', height: 32, padding: '0 10px',
      font: 'inherit', fontSize: 14, lineHeight: '22px',
      color: 'var(--dsw-alias-label-primary)',
      background: 'var(--dsw-alias-bg-layer-1)',
      border: '0.5px solid var(--dsw-alias-border-l4)',
      borderRadius: 'var(--dsw-radius-md)',
    };
    const inputNarrow = { ...input, width: 96 };
    const btnBase = {
      boxSizing: 'border-box', height: 36, font: 'inherit', fontSize: 14, lineHeight: '22px',
      cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
      borderRadius: 'var(--dsw-radius-md)', padding: '0 14px',
    };
    const primary = {
      ...btnBase, border: 'none',
      color: 'var(--dsw-alias-label-primary-foreground)',
      background: 'var(--dsw-alias-button-primary-fill)',
    };
    const secondary = {
      ...btnBase, color: 'var(--dsw-alias-label-primary)',
      background: 'transparent', border: '0.5px solid var(--dsw-alias-border-l3)',
    };
    const linkButton = {
      boxSizing: 'border-box', height: 28, padding: '0 10px',
      borderRadius: 'var(--dsw-radius-sm)', font: 'inherit', fontSize: 12, lineHeight: '18px',
      cursor: 'pointer', display: 'inline-flex', alignItems: 'center',
      color: 'var(--dsw-alias-label-tertiary)', background: 'transparent', border: 'none',
    };
    const checkRow = { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '8px 16px', width: '100%' };
    const checkItem = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)', minWidth: 0 };
    const actions = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 };

    const card = {
      display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 14px',
      background: 'var(--dsw-alias-bg-layer-1)',
      border: '0.5px solid var(--dsw-alias-border-l3)',
      borderRadius: 'var(--dsw-radius-md)',
    };
    const cardTitle = { margin: 0, fontSize: 14, fontWeight: 500, lineHeight: '20px' };
    const metaRow = { display: 'flex', flexWrap: 'wrap', gap: 16, fontSize: 12, lineHeight: '18px' };
    const metaVal = { color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums' };
    const chipRow = { display: 'flex', flexWrap: 'wrap', gap: 6 };
    const chip = {
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '1px 8px', fontSize: 12, lineHeight: '18px',
      borderRadius: 'var(--dsw-radius-sm)',
      color: 'var(--dsw-alias-label-secondary)',
      background: 'color-mix(in srgb, currentColor 8%, transparent)',
    };
    const listBox = { maxHeight: 200, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12, lineHeight: '18px' };
    const listRow = { display: 'flex', gap: 8, alignItems: 'baseline', justifyContent: 'space-between' };
    const mono = { fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)', overflowWrap: 'anywhere' };
    const successText = { color: 'var(--dsw-alias-state-success-primary)' };
    const errorText = { color: 'var(--dsw-alias-state-error-primary)' };
    const warnText = { color: 'var(--dsw-alias-state-warn-label)' };

    const dot = (color) => ({ width: 6, height: 6, borderRadius: '50%', background: color, display: 'inline-block', flex: 'none' });

    // 可同步的段落（多选）。storages 默认不列：里面主要是会话项目缓存与
    // 本机用量基线，跨机恢复只会得到悬空工作区；需要时用 /nsync config sections 追加。
    const SECTION_OPTIONS = [
      ['skills', '本机技能'],
      ['agentsSkills', '共享技能'],
      ['mcp', '插件与 MCP 配置'],
      ['plugins', '插件源码'],
      ['instructions', 'AGENTS.md'],
    ];

    /** 已知段落按固定顺序，其余（如手工配置的 storages）原样保留在末尾。 */
    function orderSections(values) {
      const known = SECTION_OPTIONS.map(([key]) => key).filter((key) => values.includes(key));
      const extra = values.filter((key) => !SECTION_OPTIONS.some(([option]) => option === key));
      return [...known, ...extra];
    }

    const PHASE_LABEL = {
      collecting: '正在收集文件',
      packing: '正在打包与校验',
      uploading: '正在上传到云端',
      retention: '正在清理旧快照',
      done: '完成',
      error: '失败',
    };

    function formatBytes(bytes) {
      const n = Number(bytes) || 0;
      if (n < 1024) return `${n} B`;
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
      if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
      return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
    }

    function toMb(bytes) {
      const value = (Number(bytes) || 0) / 1024 / 1024;
      return String(Number.isInteger(value) ? value : Number(value.toFixed(2)));
    }

    function formatWhen(iso) {
      if (!iso) return '';
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return '';
      const now = new Date();
      const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
      if (date.toDateString() === now.toDateString()) return `今天 ${time}`;
      const yesterday = new Date(now);
      yesterday.setDate(now.getDate() - 1);
      if (date.toDateString() === yesterday.toDateString()) return `昨天 ${time}`;
      return `${date.getMonth() + 1}/${date.getDate()} ${time}`;
    }

    async function call(action, args = []) {
      const res = await fetch(`${API}/${action}`, {
        method: action === 'state' ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: action === 'state' ? undefined : JSON.stringify({ args }),
      });
      return res.json();
    }

    /** 原生设置页的行：左标题/说明，右控件，底部分隔线。 */
    function Row(props) {
      const { title, desc, children, last } = props;
      const right = Array.isArray(children) ? children : [children];
      return h('div', {
        style: {
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24,
          padding: '14px 0',
          borderBottom: last ? 'none' : '0.5px solid var(--dsw-alias-border-l2)',
        },
      }, [
        h('div', { key: 'l', style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } }, [
          h('span', { key: 't', style: rowTitle }, title),
          desc ? h('span', { key: 'd', style: hint }, desc) : null,
        ]),
        h('div', { key: 'r', style: { display: 'flex', alignItems: 'center', gap: 8, flex: 'none', width: 340, justifyContent: 'flex-end' } }, right),
      ]);
    }

    function Meta(props) {
      const items = (props.items ?? []).filter((pair) => pair[1] !== undefined && pair[1] !== null && pair[1] !== '');
      return h('div', { style: metaRow }, items.map((pair, index) => h('span', { key: index },
        h('span', { style: hint }, `${pair[0]} `),
        h('span', { style: metaVal }, pair[1]))));
    }

    function SectionChips(props) {
      const entries = Object.entries(props.sections ?? {});
      if (!entries.length) return null;
      return h('div', { style: chipRow }, entries.map(([name, info]) => h('span', { key: name, style: chip },
        `${name} · ${info.files} 个 · ${formatBytes(info.bytes)}`)));
    }

    function ResultCard(props) {
      const result = props.result;
      if (!result) return null;
      const data = result.data ?? {};
      const ok = result.ok !== false;

      if (data.action === 'push') {
        const skipped = data.skipped ?? [];
        const placeholders = data.placeholders ?? [];
        const nodes = [
          h('p', { key: 't', style: { ...cardTitle, ...successText } }, data.dryRun ? '预览完成 · 未上传' : '上传完成'),
          h(Meta, { key: 'm', items: [
            ['快照', data.snapshot ? data.snapshot.name : '（未上传）'],
            ['大小', formatBytes(data.archiveBytes)],
            ['文件', `${(data.totals && data.totals.files) || 0} 个`],
            ['耗时', `${((data.durationMs || 0) / 1000).toFixed(1)} 秒`],
          ] }),
          h(SectionChips, { key: 's', sections: data.sections }),
        ];
        if (skipped.length) {
          nodes.push(h('p', { key: 'k', style: warnText },
            `跳过 ${skipped.length} 个大文件（${formatBytes(skipped.reduce((sum, f) => sum + f.bytes, 0))}）；需要带走就把「单文件上限」调大。`));
        }
        if (placeholders.length) {
          nodes.push(h('p', { key: 'p', style: hint }, `${placeholders.length} 处明文密钥已打码为 __SECRET__，恢复后需重填。`));
        }
        return h('div', { style: card }, nodes);
      }

      if (data.action === 'diff') {
        const counts = data.counts ?? { new: 0, changed: 0, same: 0, protected: 0 };
        const changes = data.changes ?? [];
        const writable = changes.filter((item) => item.status !== 'protected');
        const nodes = [
          h('p', { key: 't', style: cardTitle }, data.needsConfirm ? '恢复预览 · 待确认' : '恢复预览 · 未写入'),
          h(Meta, { key: 'm', items: [
            ['快照', data.snapshot ? data.snapshot.name : ''],
            ['大小', formatBytes(data.snapshot ? data.snapshot.bytes : 0)],
          ] }),
          h('div', { key: 'c', style: chipRow }, [
            h('span', { key: 'n', style: chip }, `新增 ${counts.new}`),
            h('span', { key: 'ch', style: chip }, `覆盖 ${counts.changed}`),
            h('span', { key: 'sa', style: chip }, `一致 ${counts.same}`),
            counts.protected ? h('span', { key: 'pr', style: chip }, `密钥保护 ${counts.protected}`) : null,
          ]),
        ];
        if (changes.length) {
          nodes.push(h('div', { key: 'l', style: listBox }, changes.slice(0, 60).map((item) => h('div', { key: item.path, style: listRow },
            h('span', { style: { ...mono, color: 'var(--dsw-alias-label-secondary)' } },
              `${item.status === 'new' ? '＋' : item.status === 'protected' ? '🔒' : '↻'} ${item.path}`),
            h('span', { style: { ...hint, flex: 'none' } }, formatBytes(item.bytes))))));
        } else {
          nodes.push(h('p', { key: 'l', style: hint }, '与本地完全一致，无需恢复。'));
        }
        if (counts.protected) {
          nodes.push(h('p', { key: 'pr', style: warnText },
            `${counts.protected} 个文件本地已有真实密钥，归档只有占位符，已跳过不覆盖。`));
        }
        if (data.needsConfirm && writable.length) {
          nodes.push(h('div', { key: 'a', style: actions }, [
            h('button', { key: 'b', style: primary, onClick: () => props.onPull(data.snapshot ? data.snapshot.name : undefined) }, '确认恢复到本地'),
            h('span', { key: 'h', style: hint }, '先备份现有文件，失败自动回滚'),
          ]));
        }
        return h('div', { style: card }, nodes);
      }

      if (data.action === 'pull') {
        const placeholders = data.placeholders ?? [];
        return h('div', { style: card }, [
          h('p', { key: 't', style: { ...cardTitle, ...successText } }, '恢复完成'),
          h(Meta, { key: 'm', items: [
            ['快照', data.snapshot ? data.snapshot.name : ''],
            ['写入', `${data.written || 0} 个文件`],
          ] }),
          h('p', { key: 'h', style: placeholders.length ? warnText : hint },
            placeholders.length
              ? `${placeholders.length} 处密钥占位符需重填；重启 DSH 后生效。`
              : '重启 DSH 后新技能与插件才完全生效。'),
        ]);
      }

      return h('div', { style: card }, [
        h('p', { key: 't', style: ok ? cardTitle : { ...cardTitle, ...errorText } }, ok ? '完成' : '操作失败'),
        h('pre', {
          key: 'b',
          style: {
            margin: 0, whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: '18px', maxHeight: 200, overflow: 'auto',
            fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
            color: ok ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-state-error-primary)',
          },
        }, result.text || ''),
      ]);
    }

    function CloudSyncSection() {
      const [state, setState] = React.useState(null);
      const [busy, setBusy] = React.useState(null);
      const [progress, setProgress] = React.useState({ phase: 'idle', message: '', startedAt: null });
      const [result, setResult] = React.useState(null);
      const [elapsed, setElapsed] = React.useState(0);
      const [draft, setDraft] = React.useState(null);
      const [saved, setSaved] = React.useState('');
      const [password, setPassword] = React.useState('');
      const [secretPassword, setSecretPassword] = React.useState('');
      const [advanced, setAdvanced] = React.useState(false);

      const refresh = React.useCallback(async () => {
        const payload = await call('state');
        const data = payload ? payload.data : null;
        if (!data) return null;
        setState(data);
        setDraft((current) => current ?? {
          baseUrl: data.config.baseUrl,
          username: data.config.username,
          remoteDir: data.config.remoteDir,
          keep: String(data.config.keep),
          sections: data.config.sections.slice(),
          maxMb: toMb(data.config.maxFileBytes),
          includeSecrets: Boolean(data.config.includeSecrets),
        });
        return data;
      }, []);

      React.useEffect(() => { refresh().catch(() => {}); }, [refresh]);

      React.useEffect(() => {
        if (!busy) return undefined;
        let alive = true;
        const tick = async () => {
          try {
            const payload = await call('state');
            const next = payload && payload.data ? payload.data.progress : null;
            if (alive && next) {
              setProgress(next);
              const started = next.startedAt ? new Date(next.startedAt).getTime() : Date.now();
              setElapsed(Math.max(0, Math.round((Date.now() - started) / 1000)));
            }
          } catch {
            /* 轮询失败不影响主请求 */
          }
        };
        tick();
        const timer = setInterval(tick, POLL_MS);
        return () => { alive = false; clearInterval(timer); };
      }, [busy]);

      const run = async (kind, args) => {
        setBusy({ kind });
        setResult(null);
        setProgress({ phase: 'collecting', message: '', startedAt: new Date().toISOString() });
        setElapsed(0);
        try {
          const payload = await call('action', args);
          setResult({ ok: payload.ok, text: payload.text, data: payload.data });
        } catch (err) {
          setResult({ ok: false, text: String(err), data: {} });
        } finally {
          setBusy(null);
          setProgress({ phase: 'idle', message: '', startedAt: null });
          await refresh();
        }
      };

      const config = state ? state.config : null;

      const snapshots = state ? state.snapshots : [];
      const credentialOk = Boolean(state && state.credentialConfigured);
      const secretPasswordConfigured = Boolean(state && state.secretPasswordConfigured);
      const disabled = Boolean(busy);
      const lastPush = state && state.state ? state.state.lastPush : null;
      const edit = (patch) => setDraft({ ...draft, ...patch });

      /** 把草稿里的一个字段转成子命令参数。 */
      const toWire = (key, value) => {
        if (key === 'sections') {
          return JSON.stringify(orderSections(value));
        }
        if (key === 'maxMb') return String(Math.round(Number(value) * 1024 * 1024));
        if (typeof value === 'boolean') return String(value);
        if (key === 'keep') return String(value);
        return JSON.stringify(value);
      };

      // 原生设置页没有保存按钮：改完即写，只给一个轻量回执
      const persist = async (patch) => {
        edit(patch);
        try {
          for (const [key, value] of Object.entries(patch)) {
            await call('action', ['config', key, toWire(key, value)]);
          }
          await refresh();
          setSaved(`已保存 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`);
        } catch (err) {
          setResult({ ok: false, text: String(err), data: {} });
        }
      };

      const toggleSection = (value, checked) => {
        const next = checked ? [...draft.sections, value] : draft.sections.filter((item) => item !== value);
        persist({ sections: next });
      };

      const blocks = [];

      // 顶部状态
      blocks.push(h('div', { key: 'status', style: { display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 6 } }, [
        h('span', { key: 'd', style: dot(credentialOk ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-warn-label)') }),
        h('span', { key: 't', style: hint },
          `${credentialOk ? '已连接' : '未配置凭据'}（${state ? state.config.username || '未填账号' : '—'}）`
          + ` · 远端 ${snapshots.length} 份快照`
          + (lastPush ? ` · 上次上传 ${formatWhen(lastPush.at)}` : '')),
      ]));

      if (state && state.remoteError) {
        blocks.push(h('p', { key: 'err', style: { ...hint, ...errorText, paddingBottom: 6 } }, state.remoteError));
      }

      // 连接
      blocks.push(h('div', { key: 'conn' }, [
        h(Row, { key: 'url', title: 'WebDAV 地址' },
          h('input', { style: input, value: draft ? draft.baseUrl : '', disabled, onChange: (e) => edit({ baseUrl: e.target.value }), onBlur: (e) => persist({ baseUrl: e.target.value }) })),
        h(Row, { key: 'user', title: '账号', desc: 'WebDAV 登录邮箱或用户名' },
          h('input', { style: input, value: draft ? draft.username : '', disabled, onChange: (e) => edit({ username: e.target.value }), onBlur: (e) => persist({ username: e.target.value }) })),
        h(Row, { key: 'pwd', title: '应用密码', desc: '存在 DSH 凭据槽，不写配置文件' }, [
          h('input', {
            key: 'i', style: { ...input, width: 'auto', flex: '1 1 auto' }, type: 'password', value: password, disabled,
            placeholder: credentialOk ? '已保存' : '在云盘服务的「应用密码 / 第三方应用」处生成',
            onChange: (e) => setPassword(e.target.value),
          }),
          h('button', {
            key: 'b', style: { ...secondary, height: 32, padding: '0 12px' }, disabled: disabled || !password,
            onClick: async () => { await run('secret', ['secret', password]); setPassword(''); },
          }, busy && busy.kind === 'secret' ? '保存中…' : '保存'),
        ]),
      ]));

      // 备份内容
      blocks.push(h('div', { key: 'scope' }, [
        h(Row, { key: 'sections', title: '备份内容', desc: '勾选要打包的配置' },
          h('div', { key: 'c', style: checkRow }, [
            ...SECTION_OPTIONS.map(([value, text]) => h('label', { key: value, style: checkItem },
              h('input', {
                type: 'checkbox', disabled,
                checked: Boolean(draft && draft.sections.includes(value)),
                onChange: (e) => toggleSection(value, e.target.checked),
              }),
              text)),
            h('label', { key: 'secrets', style: checkItem }, [
              h('input', {
                key: 'i', type: 'checkbox', disabled,
                checked: Boolean(draft && draft.includeSecrets),
                onChange: (e) => persist({ includeSecrets: e.target.checked }),
              }),
              h('span', { key: 't' }, '凭据（加密）'),
            ]),
          ])),
        draft && draft.includeSecrets
          ? h(Row, { key: 'secretpwd', title: '加密口令', desc: '保护 .credentials.yaml，存在凭据槽' }, [
              h('input', {
                key: 'i', style: { ...input, width: 'auto', flex: '1 1 auto' }, type: 'password', value: secretPassword, disabled,
                placeholder: secretPasswordConfigured ? '已保存' : '未配置，上传会失败',
                onChange: (e) => setSecretPassword(e.target.value),
              }),
              h('button', {
                key: 'b', style: { ...secondary, height: 32, padding: '0 12px' }, disabled: disabled || !secretPassword,
                onClick: async () => {
                  await run('secretref', ['secret-ref', 'CLOUD_SYNC_SECRET_PASSWORD', secretPassword]);
                  setSecretPassword('');
                },
              }, busy && busy.kind === 'secretref' ? '保存中…' : '保存'),
            ])
          : null,
        h(Row, { key: 'adv', title: '高级', desc: '远端目录、保留份数、单文件上限', last: !advanced }, [
          h('button', {
            key: 'b', style: { ...linkButton, color: 'var(--dsw-alias-label-secondary)' },
            onClick: () => setAdvanced(!advanced),
          }, advanced ? '收起' : '展开'),
        ]),
        advanced
          ? h('div', { key: 'advbody' }, [
              h(Row, { key: 'dir', title: '远端目录' },
                h('input', { style: input, value: draft ? draft.remoteDir : '', disabled, onChange: (e) => edit({ remoteDir: e.target.value }), onBlur: (e) => persist({ remoteDir: e.target.value }) })),
              h(Row, { key: 'keep', title: '保留份数', desc: '超出后自动删旧快照' },
                h('input', { style: inputNarrow, value: draft ? draft.keep : '', disabled, onChange: (e) => edit({ keep: e.target.value }), onBlur: (e) => persist({ keep: e.target.value }) })),
              h(Row, { key: 'size', title: '单文件上限（MB）', desc: '超出则跳过', last: true },
                h('input', { style: inputNarrow, value: draft ? draft.maxMb : '', disabled, onChange: (e) => edit({ maxMb: e.target.value }), onBlur: (e) => persist({ maxMb: e.target.value }) })),
            ])
          : null,
      ]));

      // 动作
      blocks.push(h('div', { key: 'act', style: { display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 16 } }, [
        h('div', { key: 'b', style: actions }, [
          h('button', { key: 'push', style: primary, disabled, onClick: () => run('push', ['push']) },
            busy && busy.kind === 'push' ? '正在上传…' : '立即上传'),
          h('button', { key: 'dry', style: secondary, disabled, onClick: () => run('dryrun', ['push', '--dry-run']) },
            busy && busy.kind === 'dryrun' ? '正在预览…' : '预览备份内容'),
          h('button', { key: 'diff', style: secondary, disabled, onClick: () => run('diff', ['pull']) },
            busy && busy.kind === 'diff' ? '正在预览…' : '预览恢复'),
          saved ? h('span', { key: 's', style: { ...hint, ...successText, marginLeft: 4 } }, saved) : null,
        ]),
        h('p', { key: 'h', style: hint }, '预览不上传、不写盘；上传只写远端快照；恢复才写本地，先备份、失败回滚。'),
      ]));

      // 进度
      if (busy && progress.phase !== 'idle') {
        blocks.push(h('div', { key: 'prog', style: { ...card, marginTop: 12, borderColor: 'var(--dsw-alias-border-l2)' } }, [
          h('div', { key: 'r', style: { display: 'flex', alignItems: 'center', gap: 8 } }, [
            h('span', { key: 'd', style: dot('var(--dsw-alias-state-business-primary)') }),
            h('p', { key: 't', style: cardTitle },
              `${PHASE_LABEL[progress.phase] || progress.phase}…${elapsed ? `　${elapsed} 秒` : ''}`),
          ]),
          progress.message ? h('p', { key: 'm', style: hint }, progress.message) : null,
        ]));
      }

      // 结果
      if (result) {
        blocks.push(h('div', { key: 'res', style: { marginTop: 12 } }, [
          h(ResultCard, {
            key: 'c', result,
            onPull: (name) => run('pull', name ? ['pull', name, '--yes'] : ['pull', '--yes']),
          }),
        ]));
      }

      // 快照
      const snapshotNodes = snapshots.slice(0, 10).map((item) => h('div', {
        key: item.name,
        style: {
          display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', fontSize: 12, lineHeight: '18px',
          borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
        },
      }, [
        h('span', { key: 'n', style: { ...metaVal, ...mono } }, item.name),
        h('span', { key: 's', style: hint }, formatBytes(item.bytes)),
        h('span', { key: 't', style: hint }, formatWhen(item.lastModified ? new Date(item.lastModified).toISOString() : null)),
        h('button', {
          key: 'b', style: { ...linkButton, marginLeft: 'auto' }, disabled,
          onClick: () => run('diff', ['pull', item.name]),
        }, '预览恢复'),
      ]));

      blocks.push(h('div', { key: 'snaps', style: { marginTop: 16 } }, [
        h('div', { key: 'h', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 4 } }, [
          h('span', { key: 't', style: { ...cardTitle, fontSize: 13 } }, `远端快照（${snapshots.length}）`),
          h('button', {
            key: 'r', style: linkButton, disabled,
            onClick: () => run('list', ['list']),
          }, busy && busy.kind === 'list' ? '刷新中…' : '刷新'),
        ]),
        snapshots.length
          ? h('div', { key: 'l' }, snapshotNodes)
          : h('p', { key: 'e', style: { ...hint, paddingTop: 4 } }, '还没有快照。先「预览备份内容」确认内容，再「立即上传」创建第一份。'),
      ]));

      return h('div', { style: wrap }, blocks);
    }

    const inject = ['slots'];

    // 导航图标由宿主按 section id 硬编码，第三方 section 用默认齿轮图标；
    // 曾试过用 DOM 补丁换成云图标，因依赖宿主结构、不可靠，已移除。
    function apply(ctx) {
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          { name: 'settings.section', id: 'cloud-sync', order: 60, label: '云同步' },
          CloudSyncSection,
        ),
      );
    }

    return { apply, inject };
  },
});
