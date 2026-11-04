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
    const createPortal = require('react-dom').createPortal;
    const h = React.createElement;

function createUi(react, createPortal) {
  const h = react.createElement
  const { useState, useEffect, useCallback, useRef } = react

  /* ---------- token 与字号 ---------- */
  const T = {
    text1: 'var(--dsw-alias-label-primary)',
    text2: 'var(--dsw-alias-label-secondary)',
    text3: 'var(--dsw-alias-label-tertiary, #8b929c)',
    line: 'var(--dsw-alias-border-l3)',
    cardFill: 'var(--dsw-alias-settings-card-fill, #2c2c2e)',
    cardStroke: 'var(--dsw-alias-settings-card-stroke, #ffffff26)',
    inputFill: 'var(--dsw-alias-bg-layer-1, #1b1b1c)',
    accent: 'var(--dsw-alias-button-primary-fill, #f9fafb)',
    accentText: 'var(--dsw-alias-label-primary-foreground, #0f1115)',
    radiusMd: 'var(--dsw-radius-md, 12px)',
    radiusXl: 'var(--dsw-radius-xl, 20px)',
  }
  const CARD_BG = 'color-mix(in srgb, currentColor 6%, transparent)'
  const TYPE = {
    h1: { fontSize: 18, fontWeight: 600, lineHeight: '26px', color: T.text1 },
    h2: { fontSize: 15, fontWeight: 600, lineHeight: '20px', color: T.text1 },
    body: { fontSize: 13, lineHeight: '20px', color: T.text1 },
    secondary: { fontSize: 13, lineHeight: '20px', color: T.text2 },
    small: { fontSize: 12, lineHeight: '18px', color: T.text2 },
    micro: { fontSize: 10, lineHeight: '13px', color: T.text2 },
    num: { fontSize: 15, fontWeight: 600, lineHeight: '20px', color: T.text1, fontVariantNumeric: 'tabular-nums' },
    ellipsis: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  }

  /* ---------- 纯函数 ---------- */
  const clamp = (value, min, max) => Math.max(min, Math.min(value, max))

  /** 浮层定位：优先右侧，放不下翻左；上下夹在视口内。pure，便于脱离 DOM 测试。 */
  function placeNear(rect, options = {}) {
    const width = options.width ?? 248
    const height = options.height ?? 120
    const gap = options.gap ?? 8
    const vw = options.viewport?.width ?? (typeof window === 'undefined' ? 1280 : window.innerWidth)
    const vh = options.viewport?.height ?? (typeof window === 'undefined' ? 800 : window.innerHeight)
    let side = 'right'
    let left = rect.right + gap
    if (left + width > vw - gap) {
      side = 'left'
      left = rect.left - gap - width
    }
    return {
      side,
      left: clamp(left, gap, Math.max(gap, vw - width - gap)),
      top: clamp(rect.top, gap, Math.max(gap, vh - height - gap)),
    }
  }

  const formatBytes = (bytes) => {
    const n = Number(bytes) || 0
    if (n < 1024) return n + ' B'
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB'
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'
  }

  /* ---------- 本地状态：模块级 store + hook ---------- */
  /** 按设备持久化；只存差异值也安全（读取时与默认值合并）。 */
  function createStore(key, defaults = {}) {
    const read = () => {
      try {
        return { ...defaults, ...JSON.parse(localStorage.getItem(key) || '{}') }
      } catch {
        return { ...defaults }
      }
    }
    const store = {
      key,
      value: read(),
      listeners: new Set(),
      set(next) {
        store.value = typeof next === 'function' ? next(store.value) : next
        try { localStorage.setItem(key, JSON.stringify(store.value)) } catch {}
        for (const listener of store.listeners) listener(store.value)
      },
      patch(part) { store.set({ ...store.value, ...part }) },
      subscribe(listener) {
        store.listeners.add(listener)
        return () => { store.listeners.delete(listener) }
      },
    }
    return store
  }

  function useStore(store) {
    const [value, setValue] = useState(store.value)
    useEffect(() => store.subscribe(setValue), [store])
    return value
  }

  /** 轮询 + 失败保留上一帧（不要闪成空）。返回 [data, error, refresh]。 */
  function usePoll(task, intervalMs, deps = []) {
    const [state, setState] = useState({ data: null, error: false })
    const run = useCallback(async () => {
      try {
        const data = await task()
        setState({ data, error: false })
      } catch {
        setState((prev) => ({ data: prev.data, error: true }))
      }
    }, deps)
    useEffect(() => {
      run()
      const timer = setInterval(run, intervalMs)
      return () => clearInterval(timer)
    }, [run, intervalMs])
    return [state.data, state.error, run]
  }

  /* ---------- 侧栏卡片 ---------- */
  const StatusDot = ({ color, size = 6, offset = 1.5 }) => h('span', {
    style: {
      width: size,
      height: size,
      borderRadius: '50%',
      backgroundColor: color || T.text3,
      flex: '0 0 auto',
      alignSelf: 'center',
      transform: `translateY(${offset}px)`,
    },
  })

  /** 侧栏卡片：一行，圆点 + 名称 + 右侧数字。左右两组用同一 baseline。 */
  const Card = ({ children, style, ...rest }) => h('div', {
    ...rest,
    style: {
      display: 'flex',
      flexDirection: 'row',
      alignItems: 'baseline',
      gap: 6,
      padding: '2px 12px 5px',
      borderRadius: T.radiusMd,
      background: CARD_BG,
      minWidth: 0,
      overflow: 'hidden',
      ...style,
    },
  }, children)

  /** 侧栏卡片容器：竖排 + 3px 间距 + 左右 2px 内缩（与 newSession 对齐）。 */
  const CardStack = ({ children }) => h('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 3, padding: '0 2px 2px', minWidth: 0 },
  }, children)

  const CardName = ({ children }) => h('span', { style: { ...TYPE.h2, fontSize: 12, flex: '1 1 auto', ...TYPE.ellipsis } }, children)
  const CardValue = ({ children }) => h('span', {
    style: { display: 'flex', alignItems: 'baseline', gap: 4, flex: '0 0 auto', ...TYPE.num },
  }, children)

  /* ---------- 设置页 ---------- */
  const Section = ({ title, description, children }) => h('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 640, minWidth: 0 },
  },
  h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 } },
    h('span', { style: TYPE.h1 }, title),
    description ? h('span', { style: TYPE.secondary }, description) : null),
  children)

  /** 设置卡片：官方那种 20px 圆角、深色填充、细描边。 */
  const SettingsCard = ({ children, style }) => h('div', {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 14,
      padding: '14px 16px',
      borderRadius: T.radiusXl,
      border: `.5px solid ${T.cardStroke}`,
      background: T.cardFill,
      minWidth: 0,
      ...style,
    },
  }, children)

  /** 左标签 + 右控件的一行。 */
  const SettingRow = ({ label, hint, children }) => h('div', {
    style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minWidth: 0 },
  },
  h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
    h('span', { style: { fontSize: 13, lineHeight: '18px', color: T.text1 } }, label),
    hint ? h('span', { style: { fontSize: 11, lineHeight: '16px', color: T.text2 } }, hint) : null),
  children)

  /** 药丸开关：36×20，白色底 + 深色旋钮，与官方设置页一致。 */
  const Switch = ({ checked, onChange, title, disabled = false }) => h('button', {
    type: 'button',
    role: 'switch',
    'aria-checked': checked,
    disabled,
    onClick: onChange,
    title,
    style: {
      boxSizing: 'border-box',
      position: 'relative',
      flex: '0 0 auto',
      width: 36,
      height: 20,
      padding: 2,
      border: 0,
      borderRadius: 999,
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.5 : 1,
      display: 'flex',
      alignItems: 'center',
      justifyContent: checked ? 'flex-end' : 'flex-start',
      transition: 'background-color .12s ease',
      backgroundColor: checked ? T.accent : 'var(--dsw-alias-border-l3, #4a4a4d)',
    },
  }, h('span', {
    style: {
      display: 'block',
      width: 16,
      height: 16,
      borderRadius: '50%',
      backgroundColor: checked ? T.accentText : 'var(--dsw-alias-label-primary, #f9fafb)',
      transition: 'background-color .12s ease',
    },
  }))

  const Button = ({ children, onClick, variant = 'primary', disabled = false, type = 'button' }) => h('button', {
    type,
    onClick,
    disabled,
    style: {
      boxSizing: 'border-box',
      height: 36,
      padding: '0 16px',
      borderRadius: T.radiusMd,
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.6 : 1,
      fontSize: 14,
      lineHeight: '22px',
      fontWeight: 500,
      ...(variant === 'primary'
        ? { border: 'none', background: T.accent, color: T.accentText }
        : { border: `.5px solid ${T.cardStroke}`, background: 'transparent', color: T.text1 }),
    },
  }, children)

  /** 文本输入：44px 高、12px 圆角，与官方设置字段一致。 */
  /** 输入框：与 Select / Button 同高（36px），支持单位后缀、禁用、错误态、回车提交。 */
  const Input = ({
    value,
    onChange,
    placeholder = '',
    type = 'text',
    width = 220,
    unit,
    disabled = false,
    invalid = false,
    min,
    max,
    step,
    autoFocus = false,
    onEnter,
  }) => {
    const [focused, setFocused] = useState(false)
    const border = invalid ? '#ff6262' : focused ? T.text3 : T.cardStroke
    return h('div', {
      style: {
        width,
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        height: 36,
        boxSizing: 'border-box',
        padding: '0 10px',
        borderRadius: T.radiusMd,
        border: `.5px solid ${border}`,
        background: T.inputFill,
        opacity: disabled ? 0.6 : 1,
        transition: 'border-color .12s ease',
      },
    },
      h('input', {
        type,
        value: value ?? '',
        placeholder,
        disabled,
        min,
        max,
        step,
        autoFocus,
        onChange: (event) => onChange?.(event.target.value),
        onFocus: () => setFocused(true),
        onBlur: () => setFocused(false),
        onKeyDown: (event) => { if (event.key === 'Enter') onEnter?.(event.target.value) },
        style: {
          flex: 1,
          minWidth: 0,
          border: 0,
          outline: 'none',
          background: 'transparent',
          color: T.text1,
          fontSize: 13,
          lineHeight: '20px',
          padding: 0,
        },
      }),
      unit ? h('span', { style: { ...TYPE.micro, flex: 'none' } }, unit) : null,
    )
  }

  /** 带标签/说明的输入框（Input 的组合封装，保留旧 API）。 */
  const TextField = ({ label, hint, width = '100%', ...props }) => h('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
  },
  label ? h('span', { style: { fontSize: 12, lineHeight: '16px', color: T.text2 } }, label) : null,
  h(Input, { width, ...props }),
  hint ? h('span', { style: TYPE.micro }, hint) : null)

  /* ---------- 浮层 ---------- */
  /** 悬停详情卡：portal 到 body，先按估算高度定位，挂载后按实测高度夹取。 */
  function HoverCard({ rect, width = 248, estimated = 120, children }) {
    const ref = useRef(null)
    const [placement, setPlacement] = useState(() => placeNear(rect, { width, height: estimated }))
    useEffect(() => {
      const node = ref.current
      if (!node) return
      const measured = node.getBoundingClientRect().height || estimated
      setPlacement(placeNear(rect, { width, height: measured }))
    }, [rect, width, estimated])
    const node = h('div', {
      ref,
      style: {
        position: 'fixed',
        left: placement.left,
        top: placement.top,
        width,
        zIndex: 2147400000,
        background: T.cardFill,
        border: `.5px solid ${T.cardStroke}`,
        borderRadius: T.radiusXl,
        padding: '12px 14px',
        boxShadow: '0 12px 32px rgba(0, 0, 0, .45)',
        color: T.text1,
      },
    }, children)
    return createPortal && typeof document !== 'undefined' ? createPortal(node, document.body) : node
  }

  /** 详情卡里的一行：左标题、右值。 */
  const InfoRow = ({ label, value }) => h('div', {
    style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, minWidth: 0 },
  },
  h('span', { style: { fontSize: 12, lineHeight: '18px', color: T.text2 } }, label),
  h('span', { style: { fontSize: 12, lineHeight: '18px', color: T.text1, fontVariantNumeric: 'tabular-nums' } }, value))

  /* ---------- 通用控件 ---------- */

  /** 下拉：触发器与设置输入框同高；浮层在触发器内绝对定位（不 portal），宽度与触发器一致。 */
  function Select({ value, options = [], onChange, width = 220, placeholder = '', disabled = false }) {
    const [open, setOpen] = useState(false)
    const [hover, setHover] = useState(-1)
    const ref = useRef(null)
    const current = options.find((option) => option.value === value)

    useEffect(() => {
      if (!open) return undefined
      const onDown = (event) => { if (ref.current && ref.current.contains(event.target)) return; setOpen(false) }
      const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
      document.addEventListener('mousedown', onDown)
      document.addEventListener('keydown', onKey)
      return () => {
        document.removeEventListener('mousedown', onDown)
        document.removeEventListener('keydown', onKey)
      }
    }, [open])

    const trigger = {
      boxSizing: 'border-box',
      width: '100%',
      height: 36,
      padding: '0 8px 0 12px',
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      borderRadius: T.radiusMd,
      border: `.5px solid ${T.cardStroke}`,
      background: T.inputFill,
      color: T.text1,
      fontSize: 13,
      lineHeight: '20px',
      cursor: disabled ? 'default' : 'pointer',
      textAlign: 'left',
      opacity: disabled ? 0.55 : 1,
    }

    return h('div', { ref, style: { position: 'relative', width, minWidth: 0 } },
      h('button', {
        type: 'button',
        disabled,
        onClick: () => { if (disabled) return; setHover(-1); setOpen((previous) => !previous) },
        style: trigger,
        'aria-haspopup': 'listbox',
        'aria-expanded': open,
      },
        h('span', { style: { ...TYPE.ellipsis, flex: 1, textAlign: 'left', color: current ? T.text1 : T.text2 } }, current ? current.label : placeholder),
        h('svg', {
          width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: T.text2,
          strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
          style: { flex: 'none', transition: 'transform .12s ease', transform: open ? 'rotate(180deg)' : 'none' },
        }, h('path', { d: 'M6 9l6 6 6-6' })),
      ),
      open && !disabled ? h('div', {
        role: 'listbox',
        style: {
          boxSizing: 'border-box',
          position: 'absolute',
          left: 0,
          top: 'calc(100% + 6px)',
          width,
          maxHeight: 320,
          overflowY: 'auto',
          padding: 4,
          zIndex: 40,
          background: T.cardFill,
          border: `.5px solid ${T.cardStroke}`,
          borderRadius: T.radiusMd,
          boxShadow: '0 12px 32px rgba(0, 0, 0, .45)',
        },
      }, options.map((option, index) => h('div', {
        key: option.value,
        role: 'option',
        'aria-selected': option.value === value,
        onMouseEnter: () => setHover(index),
        onMouseLeave: () => setHover(-1),
        onClick: () => { onChange?.(option.value); setOpen(false) },
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          height: 32,
          padding: '0 10px',
          borderRadius: 8,
          fontSize: 13,
          lineHeight: '20px',
          color: T.text1,
          cursor: 'pointer',
          background: hover === index
            ? 'color-mix(in srgb, currentColor 8%, transparent)'
            : option.value === value ? 'color-mix(in srgb, currentColor 4%, transparent)' : 'transparent',
        },
      },
        h('span', { style: { ...TYPE.ellipsis } }, option.label),
        option.value === value ? h('svg', {
          width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: T.text1,
          strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
        }, h('path', { d: 'M5 13l4 4L19 7' })) : null,
      ))) : null,
    )
  }

  /** 分段切换（2~4 项）：选中项白底黑字，未选中透明，整组与输入框同高。 */
  function Segmented({ value, options = [], onChange }) {
    return h('div', {
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        height: 36,
        padding: 2,
        boxSizing: 'border-box',
        borderRadius: T.radiusMd,
        border: `.5px solid ${T.cardStroke}`,
        background: T.inputFill,
      },
    }, options.map((option) => {
      const active = option.value === value
      return h('button', {
        key: option.value,
        type: 'button',
        onClick: () => onChange?.(option.value),
        style: {
          height: 30,
          padding: '0 12px',
          border: 'none',
          borderRadius: 9,
          cursor: 'pointer',
          fontSize: 13,
          lineHeight: '20px',
          background: active ? T.accent : 'transparent',
          color: active ? T.accentText : T.text2,
          transition: 'background-color .12s ease, color .12s ease',
        },
      }, option.label)
    }))
  }

  /** 图标按钮：28×28，hover 有底色；用于行内删除、刷新等。 */
  const IconButton = ({ label, onClick, disabled = false, children }) => h('button', {
    type: 'button',
    title: label,
    'aria-label': label,
    onClick,
    disabled,
    style: {
      width: 28,
      height: 28,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      border: 0,
      borderRadius: 8,
      background: 'transparent',
      color: disabled ? T.text3 : T.text2,
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.6 : 1,
    },
  }, children)

  /** 指标块：上标签、下数值，用于面板顶部摘要。 */
  const StatTile = ({ label, value, hint }) => h('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 96 },
  },
  h('span', { style: TYPE.micro }, label),
  h('span', { style: { ...TYPE.num, fontSize: 17, lineHeight: '22px' } }, value),
  hint ? h('span', { style: TYPE.micro }, hint) : null)

  /** 空态：居中提示，不占空容器。 */
  const EmptyState = ({ title, hint }) => h('div', {
    style: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, padding: '24px 12px', textAlign: 'center' },
  },
  h('span', { style: TYPE.body }, title),
  hint ? h('span', { style: TYPE.small }, hint) : null)

  return {
    h, T, TYPE, CARD_BG,
    clamp, placeNear, formatBytes,
    createStore, useStore, usePoll,
    Card, CardStack, CardName, CardValue, StatusDot,
    Section, SettingsCard, SettingRow, Switch, Button, Input, TextField,
    Select, Segmented, IconButton, StatTile, EmptyState,
    HoverCard, InfoRow,
  }
}

    const ui = createUi(React, createPortal);
    const { Select } = ui;

    const API = '/cloud-sync/api';
    const POLL_MS = 700;

    // —— 与原生设置页一致的取值 ——
    const wrap = { display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 720, color: 'var(--dsw-alias-label-primary)' };
    const hint = { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' };
    const rowTitle = { fontSize: 14, fontWeight: 500, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' };
    /** 原生字段标签：14px、次级色，控件在其下方 6px 处 */
    const fieldLabel = { fontSize: 12, fontWeight: 500, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' };
    /** 原生设置行的左侧标签：14px、常规字重、主色 */
    const rowLabel = { fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' };

    /** 原生设置页的分组卡片：#2c2c2e 填充 + 半透明白描边 + 20px 圆角 */
    const group = {
      display: 'flex', flexDirection: 'column',
      padding: '2px 14px',
      background: 'var(--dsw-alias-settings-card-fill)',
      border: '0.5px solid var(--dsw-alias-settings-card-stroke)',
      borderRadius: 'var(--dsw-radius-xl)',
    };
    const groupHead = {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
      padding: '12px 0 0',
    };

    const input = {
      boxSizing: 'border-box', width: '100%', height: 32, padding: '0 10px',
      font: 'inherit', fontSize: 14, lineHeight: '22px',
      color: 'var(--dsw-alias-label-primary)',
      background: 'var(--dsw-alias-bg-layer-1)',
      border: '0.5px solid var(--dsw-alias-border-l3)',
      borderRadius: 'var(--dsw-radius-sm)',
    };
    const inputNarrow = { ...input, width: '100%' };
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
    /** 原生 Checkbox 原语：14px 标签、6px 间距、16×16 框、accent-color 用 brand-primary(#f9fafb) */
    const checkItem = {
      display: 'inline-flex', alignItems: 'center', gap: 6,
      fontSize: 14, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)',
      cursor: 'pointer', minWidth: 0,
    };
    const checkBox = {
      flex: '0 0 auto', width: 16, height: 16, margin: 0,
      accentColor: 'var(--dsw-alias-brand-primary)', cursor: 'inherit',
    };
    const actions = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: 8 };

    const pageTitle = { margin: 0, fontSize: 18, fontWeight: 600, lineHeight: '24px', color: 'var(--dsw-alias-label-primary)' };
    const pageIntro = { margin: 0, fontSize: 13, lineHeight: '17px', color: 'var(--dsw-alias-label-tertiary)' };
    const confirmBox = {
      display: 'flex', flexDirection: 'column', gap: 8, padding: '12px',
      background: 'var(--dsw-alias-bg-layer-1)',
      border: '0.5px solid var(--dsw-alias-border-l3)',
      borderRadius: 'var(--dsw-radius-md)',
    };

    const card = {
      display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 14px',
      background: 'var(--dsw-alias-settings-card-fill)',
      border: '0.5px solid var(--dsw-alias-settings-card-stroke)',
      borderRadius: 'var(--dsw-radius-lg)',
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
    // 本机用量基线，跨机恢复只会得到悬空工作区；需要时用 /csync config sections 追加。
    const SECTION_OPTIONS = [
      ['skills', '本机技能（~/.dsh）'],
      ['agentsSkills', '共享技能（~/.agents）'],
      ['mcp', 'DSH 配置与插件清单'],
      ['plugins', '本地插件源码（link）'],
      ['localPlugins', '本地插件副本（local-plugins）'],
      ['instructions', '全局指令（AGENTS.md）'],
      ['memories', '记忆库（memories）'],
      ['storages', '工作区与插件状态（storages）'],
      ['skillLock', '技能来源清单（.skill-lock）'],
      ['profiles', '其他 profile 配置'],
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

    /** 原生编辑器字段：标签在上、控件在下（模型页的字段就是这个排法）。 */
    function Field(props) {
      const { label, desc, children } = props;
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 } }, [
        h('div', { key: 'l', style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } }, [
          h('span', { key: 't', style: fieldLabel }, label),
          desc ? h('span', { key: 'd', style: hint }, desc) : null,
        ]),
        h('div', { key: 'c', style: { minWidth: 0 } }, children),
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
            `已跳过 ${skipped.length} 个文件（${formatBytes(skipped.reduce((sum, f) => sum + f.bytes, 0))}），如需包含请在配置的 exclude 中调整。`));
        }
        if (placeholders.length) {
          const sealed = placeholders.filter((item) => item.encrypted).length;
          const masked = placeholders.length - sealed;
          if (sealed) nodes.push(h('p', { key: 'p', style: hint }, `${sealed} 处明文密钥已加密，恢复时用同一口令自动还原。`));
          if (masked) nodes.push(h('p', { key: 'q', style: hint }, `${masked} 处明文密钥已打码为 __SECRET__，恢复后需重填。`));
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
              `${item.status === 'new' ? '+' : item.status === 'protected' ? '!' : '~'} ${item.path}`),
            h('span', { style: { ...hint, flex: 'none' } }, formatBytes(item.bytes))))));
        } else {
          nodes.push(h('p', { key: 'l', style: hint }, '与本地完全一致，无需恢复。'));
        }
        if (counts.protected) {
          nodes.push(h('p', { key: 'pr', style: warnText },
            `${counts.protected} 个文件本地已有真实密钥，归档内为占位符，已跳过。`));
        }
        if (data.needsConfirm && writable.length) {
          nodes.push(h('div', { key: 'a', style: actions }, [
            h('button', { key: 'b', style: primary, onClick: () => props.onPull(data.snapshot ? data.snapshot.name : undefined) }, '确认恢复到本地'),
            h('span', { key: 'h', style: hint }, '先备份现有文件，失败时自动回滚'),
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
              ? `${placeholders.length} 处占位符需重填。重启 DSH 后生效。`
              : '重启 DSH 后新技能与插件生效。'),
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
      // 待确认动作：{ kind: 'push' | 'pull', data, snapshot? }
      const [pending, setPending] = React.useState(null);
      const [pendingDelete, setPendingDelete] = React.useState('');

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
          includeSecrets: Boolean(data.config.includeSecrets),
          fullSyncMinutes: Number(data.config.fullSyncMinutes ?? 0),
        });
        // 关闭设置再打开时，服务端可能还在打包/上传：接管它的进度，避免界面回到初始态
        const phase = data.progress ? data.progress.phase : 'idle';
        const active = phase !== 'idle' && phase !== 'done' && phase !== 'error';
        if (active) {
          setBusy((current) => current ?? { kind: 'remote' });
          setProgress(data.progress);
        } else {
          setBusy((current) => (current && current.kind === 'remote' ? null : current));
        }
        return data;
      }, []);

      React.useEffect(() => { refresh().catch(() => {}); }, [refresh]);

      // 常驻轻量轮询：无论本地是否在跑动作，都用服务端 progress 校正界面，
      // 这样关闭设置再打开、或者别的入口触发上传，都能看到真实进度。
      React.useEffect(() => {
        const timer = setInterval(() => { refresh().catch(() => {}); }, 1500);
        return () => clearInterval(timer);
      }, [refresh]);

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
              const phase = next.phase ?? 'idle';
              if (phase === 'idle' || phase === 'done' || phase === 'error') {
                // 远端任务结束：清掉接管状态并刷新一次，拿到最新的快照与上次推送
                await refresh();
              }
            }
          } catch {
            /* 轮询失败不影响主请求 */
          }
        };
        tick();
        const timer = setInterval(tick, POLL_MS);
        return () => { alive = false; clearInterval(timer); };
      }, [busy, refresh]);

      const run = async (kind, args) => {
        setBusy({ kind });
        setResult(null);
        setProgress({ phase: 'collecting', message: '', startedAt: new Date().toISOString() });
        setElapsed(0);
        let payload = null;
        try {
          payload = await call('action', args);
          setResult({ ok: payload.ok, text: payload.text, data: payload.data });
        } catch (err) {
          setResult({ ok: false, text: String(err), data: {} });
        } finally {
          setBusy(null);
          setProgress({ phase: 'idle', message: '', startedAt: null });
          await refresh();
        }
        return payload;
      };

      const config = state ? state.config : null;

      const snapshots = state ? state.snapshots : [];
      const credentialOk = Boolean(state && state.credentialConfigured);
      const disabled = Boolean(busy);
      const lastPush = state && state.state ? state.state.lastPush : null;
      const edit = (patch) => setDraft({ ...draft, ...patch });

      /** 把草稿里的一个字段转成子命令参数。 */
      const toWire = (key, value) => {
        if (key === 'sections') {
          return JSON.stringify(orderSections(value));
        }
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

      const autoMode = draft ? (draft.autoSyncMode ?? 'off') : 'off';
      /** 自动同步：模式下拉 + 对应的时间数值，改完即生效（宿主每 30 秒读一次配置） */
      const autoSyncControl = () => h('div', { key: 'r', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }, [
        h(Select, {
          key: 'm', width: 116, value: autoMode, disabled,
          options: [
            { value: 'off', label: '关闭' },
            { value: 'interval', label: '定时' },
            { value: 'watch', label: '改动后' },
          ],
          onChange: (next) => persist({ autoSyncMode: next }),
        }),
        autoMode === 'interval'
          ? h('div', { key: 'i', style: { display: 'flex', alignItems: 'center', gap: 6 } }, [
              h('input', {
                key: 'n', type: 'number', min: 1, style: { ...input, width: 72, flex: 'none' },
                value: draft ? draft.autoSyncMinutes : 60, disabled,
                onChange: (e) => edit({ autoSyncMinutes: Number(e.target.value) }),
                onBlur: (e) => persist({ autoSyncMinutes: Math.max(1, Number(e.target.value) || 60) }),
              }),
              h('span', { key: 'u', style: hint }, '分钟一次'),
            ])
          : null,
        autoMode === 'watch'
          ? h('div', { key: 'w', style: { display: 'flex', alignItems: 'center', gap: 6 } }, [
              h('input', {
                key: 'n', type: 'number', min: 10, style: { ...input, width: 72, flex: 'none' },
                value: draft ? draft.autoSyncDebounceSeconds : 90, disabled,
                onChange: (e) => edit({ autoSyncDebounceSeconds: Number(e.target.value) }),
                onBlur: (e) => persist({ autoSyncDebounceSeconds: Math.max(10, Number(e.target.value) || 90) }),
              }),
              h('span', { key: 'u', style: hint }, '秒内无改动后上传'),
            ])
          : null,
        autoMode === 'off' ? h('span', { key: 'o', style: hint }, '仅手动上传') : null,
        h('span', { key: 'sep', style: hint }, '｜全量'),
        h(Select, {
          key: 'f', width: 96,
          value: draft && Number(draft.fullSyncMinutes) > 0 ? 'on' : 'off',
          disabled: disabled || !draft,
          options: [
            { value: 'off', label: '关闭' },
            { value: 'on', label: '每周' },
          ],
          onChange: (next) => persist({ fullSyncMinutes: next === 'on' ? 10080 : 0 }),
        }),
        h('span', { key: 'fh', style: hint }, '（含技能库）'),
      ]);

      const blocks = [];

      // 标题与简介（与「Agent 预设」等原生分区一致的页头）
      blocks.push(h('div', { key: 'head', style: { display: 'flex', flexDirection: 'column', gap: 6 } }, [
        h('h2', { key: 't', style: pageTitle }, '云同步'),
        h('p', { key: 'd', style: pageIntro }, '把技能、插件、DSH 配置与全局指令备份到 WebDAV；换机器时可从快照恢复。'),
        h('div', { key: 's', style: { display: 'flex', alignItems: 'center', gap: 8 } }, [
          h('span', { key: 'dot', style: dot(credentialOk ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-warn-label)') }),
          h('span', { key: 'txt', style: hint },
            `${credentialOk ? '已连接' : '未配置凭据'}（${state ? state.config.username || '未填账号' : '—'}）`
            + ` · 远端 ${snapshots.length} 份快照`
            + (lastPush ? ` · 上次上传 ${formatWhen(lastPush.at)}` : '')),
        ]),
      ]));

      if (state && state.remoteError) {
        blocks.push(h('p', { key: 'err', style: { ...hint, ...errorText, paddingBottom: 6 } }, state.remoteError));
      }

      // 连接：标签与控件同一行（原生设置页的行式布局）
      const connRow = (key, label, control, last) => h('div', {
        key,
        style: {
          display: 'flex', alignItems: 'center', gap: 16, padding: '14px 0',
          borderBottom: last ? 'none' : '0.5px solid var(--dsw-alias-border-l2)',
        },
      }, [
        h('span', { key: 'l', style: { ...rowLabel, flex: '0 0 auto', width: 104 } }, label),
        h('div', { key: 'c', style: { flex: '1 1 auto', minWidth: 0 } }, control),
      ]);

      blocks.push(h('div', { key: 'conn', style: { ...group, gap: 0, padding: '4px 16px' } }, [
        connRow('url', 'WebDAV 地址',
          h('input', { style: input, value: draft ? draft.baseUrl : '', placeholder: 'https://dav.example.com/dav/', disabled, onChange: (e) => edit({ baseUrl: e.target.value }), onBlur: (e) => persist({ baseUrl: e.target.value }) })),
        connRow('user', '账号',
          h('input', { style: input, value: draft ? draft.username : '', placeholder: '登录邮箱或用户名', disabled, onChange: (e) => edit({ username: e.target.value }), onBlur: (e) => persist({ username: e.target.value }) })),
        connRow('pwd', '应用密码', h('div', { key: 'r', style: { display: 'flex', alignItems: 'center', gap: 8 } }, [
          h('input', {
            key: 'i', style: { ...input, flex: '1 1 auto' }, type: 'password', value: password, disabled,
            placeholder: credentialOk ? '已保存' : '在云盘服务的「应用密码 / 第三方应用」处生成',
            onChange: (e) => setPassword(e.target.value),
          }),
          h('button', {
            key: 'b', style: { ...secondary, height: 32, padding: '0 14px', flex: 'none' }, disabled: disabled || !password,
            onClick: async () => { await run('secret', ['secret', password]); setPassword(''); },
          }, busy && busy.kind === 'secret' ? '保存中…' : '保存'),
        ])),
        connRow('dir', '远端目录',
          h('input', { style: input, value: draft ? draft.remoteDir : '', placeholder: 'dsh-sync', disabled, onChange: (e) => edit({ remoteDir: e.target.value }), onBlur: (e) => persist({ remoteDir: e.target.value }) })),
        connRow('auto', '自动同步', autoSyncControl(), true),
      connRow('usage', '本月流量', (() => {
        const usageInfo = state && state.usage ? state.usage : null;
        const now = new Date();
        const localMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const sameMonth = Boolean(usageInfo && usageInfo.month === localMonth);
        const used = sameMonth ? Number(usageInfo.bytes) || 0 : 0;
        const percent = Math.min(100, Math.round((used / (1024 * 1024 * 1024)) * 100));
        return h('div', { key: 'u', style: { display: 'flex', alignItems: 'center', gap: 8 } }, [
          h('span', { key: 't', style: rowLabel }, used ? `${formatBytes(used)} / 1 GB（${percent}%）` : '0 B / 1 GB'),
          h('span', { key: 'h', style: hint }, '坚果云免费额度，按上传计费'),
        ]);
      })()),
      ]));

      // 备份内容
      blocks.push(h('div', { key: 'scope', style: { ...group, gap: 14, padding: '14px 16px' } }, [
        h(Field, { key: 'sections', label: '备份内容' },
          h('div', { key: 'c', style: checkRow }, [
            ...SECTION_OPTIONS.map(([value, text]) => h('label', { key: value, style: checkItem },
              h('input', {
                type: 'checkbox', style: checkBox, disabled,
                checked: Boolean(draft && draft.sections.includes(value)),
                onChange: (e) => toggleSection(value, e.target.checked),
              }),
              text)),
            h('label', { key: 'secrets', style: checkItem }, [
              h('input', {
                key: 'i', type: 'checkbox', style: checkBox, disabled,
                checked: Boolean(draft && draft.includeSecrets),
                onChange: (e) => persist({ includeSecrets: e.target.checked }),
              }),
              h('span', { key: 't' }, '模型凭据（加密）'),
            ]),
          ])),
      ]));

      // 动作：先预览、再确认
      const startUpload = async () => {
        setPending(null);
        const payload = await run('dryrun', ['push', '--dry-run']);
        if (payload && payload.ok !== false) setPending({ kind: 'push', data: payload.data ?? {} });
      };
      const startRestore = async (name) => {
        setPending(null);
        const payload = await run('diff', name ? ['pull', name] : ['pull']);
        if (payload && payload.ok !== false) setPending({ kind: 'pull', data: payload.data ?? {}, snapshot: name });
      };

      const actionNodes = [
        saved ? h('span', { key: 's', style: { ...hint, ...successText, marginRight: 'auto' } }, saved) : null,
        h('button', {
          key: 'restore', style: secondary, disabled, className: 'cs-btn',
          onClick: () => startRestore(''),
        }, busy && busy.kind === 'diff' ? '正在读取…' : '恢复'),
        h('button', {
          key: 'upload', style: primary, disabled, className: 'cs-btn cs-btn-primary',
          onClick: startUpload,
        }, busy && busy.kind === 'dryrun' ? '正在统计…' : '上传'),
      ];

      if (pending) {
        actionNodes.unshift(h('div', { key: 'confirm', style: confirmBox }, [
          h('p', { key: 'q', style: { ...rowTitle, margin: 0 } },
            pending.kind === 'push'
              ? `将上传 ${pending.data.totals?.files ?? 0} 个文件（${formatBytes(pending.data.archiveBytes)}）到 ${config ? config.remoteDir : ''}/`
              : `将恢复 ${pending.data.changes?.length ?? 0} 个文件（${pending.snapshot || '最新快照'}）`),
          h('p', { key: 'w', style: hint },
            pending.kind === 'push'
              ? '只写远端，不改本地文件。'
              : '会先备份现有文件，失败自动回滚；需要重启 DSH 才生效。'),
          h('div', { key: 'b', style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } }, [
            h('button', { key: 'c', style: secondary, className: 'cs-btn', onClick: () => setPending(null) }, '取消'),
            h('button', {
              key: 'ok', style: primary, className: 'cs-btn cs-btn-primary', disabled,
              onClick: async () => {
                const action = pending.kind;
                const name = pending.snapshot;
                setPending(null);
                if (action === 'push') await run('push', ['push']);
                else await run('pull', name ? ['pull', name, '--yes'] : ['pull', '--yes']);
              },
            }, pending.kind === 'push' ? '确认上传' : '确认恢复'),
          ]),
        ]));
      }

      blocks.push(h('div', { key: 'act', style: { ...group, gap: 10, padding: '14px 16px' } }, [
        h('p', { key: 'h', style: hint }, '上传只写远端；恢复才写本地，且先备份、失败回滚。两步都会先给出摘要再执行。'),
        h('div', { key: 'b', style: actions }, actionNodes),
      ]));

      // 进度
      if (busy && progress.phase !== 'idle') {
        blocks.push(h('div', { key: 'prog', style: { ...card } }, [
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
        blocks.push(h('div', { key: 'res' }, [
          h(ResultCard, {
            key: 'c', result,
            onPull: (name) => startRestore(name || ''),
          }),
        ]));
      }

      // 快照（最后一行不画分隔线，避免和卡片底边重复）
      const snapshotList = snapshots.slice(0, 10);
      const snapshotNodes = snapshotList.map((item, index) => h('div', {
        key: item.name,
        style: {
          display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', fontSize: 12, lineHeight: '18px',
          borderBottom: index === snapshotList.length - 1 ? 'none' : '0.5px solid var(--dsw-alias-border-l2)',
        },
      }, [
        h('span', { key: 'n', style: { ...metaVal, ...mono } }, item.name),
        h('span', { key: 's', style: hint }, formatBytes(item.bytes)),
        h('span', { key: 't', style: hint }, formatWhen(item.lastModified ? new Date(item.lastModified).toISOString() : null)),
        pendingDelete === item.name
          ? h('div', { key: 'del', style: { display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' } }, [
              h('span', { key: 'q', style: { ...hint, ...warnText } }, '删除该快照？'),
              h('button', {
                key: 'y', style: { ...linkButton, ...warnText }, className: 'cs-btn', disabled,
                onClick: async () => { setPendingDelete(''); await run('delete', ['delete', item.name]); },
              }, '删除'),
              h('button', { key: 'n', style: linkButton, className: 'cs-btn', onClick: () => setPendingDelete('') }, '取消'),
            ])
          : h('div', { key: 'ops', style: { display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto' } }, [
              h('button', {
                key: 'r', style: linkButton, className: 'cs-btn', disabled,
                onClick: () => startRestore(item.name),
              }, '恢复'),
              h('button', {
                key: 'd', style: linkButton, className: 'cs-btn', disabled,
                onClick: () => setPendingDelete(item.name),
              }, '删除'),
            ]),
      ]));

      blocks.push(h('div', { key: 'snaps', style: { ...group, gap: 0 } }, [
        h('div', { key: 'h', style: groupHead }, [
          h('span', { key: 't', style: { ...rowTitle } }, `远端快照（${snapshots.length}）`),
          h('button', {
            key: 'r', style: linkButton, className: 'cs-btn', disabled,
            onClick: () => run('list', ['list']),
          }, busy && busy.kind === 'list' ? '刷新中…' : '刷新'),
        ]),
        snapshots.length
          ? h('div', { key: 'l', style: { paddingBottom: 2 } }, snapshotNodes)
          : h('p', { key: 'e', style: { ...hint, paddingTop: 4 } }, '暂无快照。点击「上传」会先给出待上传内容，确认后再执行。'),
      ]));

      return h('div', { style: wrap }, blocks);
    }

    const inject = ['slots'];

    /**
     * 内联样式写不了 :hover，这里插一段样式表，实现与原生一致的悬停反馈：
     * 次按钮/文字按钮加底色，主按钮用主色 hover。
     */
    const HOVER_CSS = [
      '.cs-btn { transition: background-color .12s ease, border-color .12s ease; }',
      '.cs-btn:not(:disabled):hover { background: var(--dsw-alias-interactive-bg-hover); }',
      '.cs-btn-primary:not(:disabled):hover { background: var(--dsw-alias-button-primary-hover); }',
    ].join('\n');

    function ensureHoverStyle() {
      if (typeof document === 'undefined') return;
      if (document.getElementById('cloud-sync-hover')) return;
      const tag = document.createElement('style');
      tag.id = 'cloud-sync-hover';
      tag.textContent = HOVER_CSS;
      document.head.appendChild(tag);
    }

    // 导航图标由宿主按 section id 硬编码，第三方 section 用默认齿轮图标。
    function apply(ctx) {
      ensureHoverStyle();
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
