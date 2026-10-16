/**
 * Client half of @local/dsh-mcp-switch.
 *
 * Contributes one Settings page that lists every Loader row whose module is the
 * MCP client (`@deepseek-ai/dsh-mcp-client`) and switches each one through the
 * existing `pluginManager` Remote. Toggling writes the profile patch and the
 * Loader reload lifecycle applies it, so no restart is involved while HMR is
 * mounted.
 *
 * Plain JavaScript, no build step: the module table supplies React, the page
 * styles itself with theme tokens only, and the registration lives in
 * `settings.section` (one page per list entry).
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-mcp-switch',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Every MCP server row is an instance of this package. */
    const MCP_MODULE = '@deepseek-ai/dsh-mcp-client';
    /** Dictionary namespace owned by this plugin. */
    const NS = 'mcp-switch';
    /** Settings nav id; a fresh id adds this page beside the shipped ones. */
    const SECTION_ID = 'mcp-switch';

    /** English copy. */
    const en = {
      nav: 'MCP servers',
      title: 'MCP server switches',
      intro:
        'Turn individual MCP servers on or off. A change applies at once to every session in this profile, and it is written to the profile configuration so it survives a restart.',
      loading: 'Reading MCP servers…',
      empty: 'This profile declares no MCP server rows.',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      hint: 'Disabling a server removes its tools from every session; enabling it restores them.',
      stateOn: 'Enabled',
      stateOff: 'Disabled',
      stateLocked: 'Managed elsewhere',
      turnOn: 'Enable',
      turnOff: 'Disable',
      applied: 'Applied — the change is live.',
      restartRequired: 'Saved, but this profile needs a restart to apply it.',
      overridden:
        'A higher-priority layer overrides this row — usually the machine-local $DSH_HOME/cordis.patch.yml, which outranks the profile patch. Move the row into the profile patch to switch it here.',
      failed: 'The change failed.',
    };

    /** Simplified Chinese copy. */
    const zh = {
      nav: 'MCP 服务',
      title: 'MCP 服务开关',
      intro:
        '逐个启用或停用 MCP 服务器。改动立即对本 profile 的所有会话生效，并写入 profile 配置，重启后保持。',
      loading: '正在读取 MCP 服务…',
      empty: '当前 profile 没有 MCP 服务器条目。',
      refresh: '刷新',
      refreshing: '刷新中…',
      hint: '停用后该服务的工具会从所有会话的工具列表中移除；重新启用即恢复。',
      stateOn: '已启用',
      stateOff: '已停用',
      stateLocked: '不可在此管理',
      turnOn: '启用',
      turnOff: '停用',
      applied: '已应用，立即生效。',
      restartRequired: '已保存，但本 profile 需要重启后才生效。',
      overridden:
        '该条目被更高优先级的配置层覆盖——通常是机器级层 $DSH_HOME/cordis.patch.yml（它优先级高于 profile 补丁）。把该行移到 profile 补丁后才能在这里开关。',
      failed: '改动失败。',
    };

    /**
     * Friendly names for the MCP rows this deployment declares. Any other MCP
     * row still appears, labelled from its own patch id.
     */
    const KNOWN = {
      'rea-mcp': {
        name: 'rea',
        desc: '逆向工程：Ghidra / Hopper / Frida、崩溃转储、固件与安装包分析',
      },
      'mcp-gitnexus': {
        name: 'gitnexus',
        desc: '代码知识图谱：仓库索引、调用关系、影响面与执行流程追踪',
      },
      'mcp-superting': {
        name: 'superting',
        desc: '本地笔记与会议：笔记、转写片段、词典与联系人读写',
      },
    };

    /** A row's patch id is the stable identity a profile edit targets. */
    function rowKey(entry) {
      const patchId = entry.patchId;
      if (typeof patchId === 'string' && patchId !== '') return patchId;
      return String(entry.entryId ?? '').replace(/^include:/, '');
    }

    /** Display text for one MCP row, falling back to its patch id. */
    function describe(entry) {
      const key = rowKey(entry);
      const known = KNOWN[key] ?? KNOWN[entry.entryId];
      if (known !== void 0) return { key, name: known.name, desc: known.desc };
      const name = key.replace(/^mcp-/, '').replace(/-mcp$/, '') || key;
      return { key, name, desc: '' };
    }

    /** Readable text for a rejection, which may be an Error or a diagnostic code. */
    function messageOf(error) {
      if (error === void 0 || error === null) return '';
      if (typeof error === 'string') return error;
      const message = error.message ?? error.code;
      return typeof message === 'string' && message !== '' ? message : String(error);
    }

    /**
     * The page's data: the MCP rows the Host reports, plus one in-flight toggle.
     * Every mutation re-reads the Host, which stays the only source of truth.
     */
    function createStore(ctx) {
      let state = { status: 'idle', servers: [], error: '', notice: '', busy: '' };
      const listeners = new Set();
      const emit = (patch) => {
        state = { ...state, ...patch };
        for (const listener of listeners) listener();
      };
      const getSnapshot = () => state;
      const subscribe = (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      };
      const dispose = () => {
        listeners.clear();
      };

      async function load() {
        emit({ status: state.status === 'ready' ? 'refreshing' : 'loading', error: '' });
        try {
          const answer = await ctx.remote.pluginManager.listPlugins();
          if (!answer.ok) {
            emit({ status: 'error', error: messageOf(answer.error) });
            return;
          }
          const servers = answer.value
            .filter((entry) => entry.moduleName === MCP_MODULE)
            .map((entry) => ({ ...entry, ...describe(entry), locked: entry.readOnlyReason !== void 0 }));
          emit({ status: 'ready', servers, error: '' });
        } catch (error) {
          emit({ status: 'error', error: messageOf(error) });
        }
      }

      async function toggle(entryId, enabled) {
        emit({ busy: entryId, error: '', notice: '' });
        let notice = '';
        let failure = '';
        try {
          const answer = await ctx.remote.pluginManager.setPluginEnabled(entryId, enabled);
          if (!answer.ok) {
            notice = 'failed';
            failure = messageOf(answer.error);
          } else {
            const application = answer.value?.application;
            notice =
              application === 'applied'
                ? 'applied'
                : application === 'restart-required'
                  ? 'restartRequired'
                  : application === 'overridden'
                    ? 'overridden'
                    : 'failed';
            if (notice === 'failed') failure = messageOf(answer.value?.error);
          }
        } catch (error) {
          notice = 'failed';
          failure = messageOf(error);
        }
        // The re-read clears every notice, so the outcome is written after it.
        await load();
        emit({ busy: '', notice, error: failure });
      }

      return { getSnapshot, subscribe, dispose, load, toggle };
    }

    /** The switch control: a real button with `role="switch"` and `aria-checked`. */
    function Switch({ checked, disabled, label, onClick }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked,
          'aria-label': label,
          className: 'mcps-switch',
          'data-checked': checked ? 'true' : 'false',
          disabled,
          onClick,
        },
        h('span', { className: 'mcps-knob' }),
      );
    }

    /** One MCP row: identity, state, and the switch. */
    function Row({ entry, t, busy, onToggle }) {
      const name = entry.name;
      return h(
        'li',
        { className: 'mcps-row' },
        h(
          'div',
          { className: 'mcps-info' },
          h('div', { className: 'mcps-name' }, name),
          entry.desc !== '' ? h('div', { className: 'mcps-desc' }, entry.desc) : null,
          h(
            'div',
            { className: 'mcps-meta' },
            h(
              'span',
              { className: 'mcps-state', 'data-on': entry.enabled ? 'true' : 'false' },
              entry.locked ? t('stateLocked') : entry.enabled ? t('stateOn') : t('stateOff'),
            ),
            h('code', { className: 'mcps-code' }, entry.entryId ?? entry.key),
          ),
        ),
        h(Switch, {
          checked: entry.enabled === true,
          disabled: entry.locked || busy,
          label: (entry.enabled ? t('turnOff') : t('turnOn')) + ' ' + name,
          onClick: () => {
            void onToggle(entry.entryId, !entry.enabled);
          },
        }),
      );
    }

    /** The Settings page itself. */
    function McpSwitchSection({ t, store }) {
      const [state, setState] = React.useState(() => store.getSnapshot());
      React.useEffect(() => {
        setState(store.getSnapshot());
        return store.subscribe(() => setState(store.getSnapshot()));
      }, [store]);

      const servers = state.servers;
      const refreshing = state.status === 'refreshing';
      return h(
        'section',
        { className: 'mcps-section' },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        h('h2', { className: 'mcps-title' }, t('title')),
        h('p', { className: 'mcps-intro' }, t('intro')),
        state.error !== '' ? h('p', { className: 'mcps-error', role: 'alert' }, state.error) : null,
        state.notice !== '' ? h('p', { className: 'mcps-notice' }, t(state.notice)) : null,
        servers.length === 0
          ? h('p', { className: 'mcps-empty' }, t(state.status === 'loading' ? 'loading' : 'empty'))
          : h(
              'ul',
              { className: 'mcps-list' },
              servers.map((entry) =>
                h(Row, {
                  key: entry.entryId ?? entry.key,
                  entry,
                  t,
                  busy: state.busy === entry.entryId,
                  onToggle: store.toggle,
                }),
              ),
            ),
        h(
          'div',
          { className: 'mcps-footer' },
          h(
            'button',
            {
              type: 'button',
              className: 'mcps-button',
              disabled: refreshing,
              onClick: () => {
                void store.load();
              },
            },
            refreshing ? t('refreshing') : t('refresh'),
          ),
          h('span', { className: 'mcps-hint' }, t('hint')),
        ),
      );
    }

    /** Page styles. Theme tokens only, so light and dark both work. */
    const CSS = [
      '.mcps-section{display:flex;flex-direction:column;gap:12px}',
      '.mcps-title{margin:0;font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.mcps-intro{margin:0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',
      '.mcps-error{margin:0;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);font-size:13px}',
      '.mcps-notice{margin:0;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);font-size:13px}',
      '.mcps-empty{margin:0;font-size:13px;color:var(--dsw-alias-label-secondary)}',
      '.mcps-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}',
      '.mcps-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}',
      '.mcps-info{min-width:0;display:flex;flex-direction:column;gap:4px}',
      '.mcps-name{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.mcps-desc{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.mcps-meta{display:flex;align-items:center;gap:8px}',
      '.mcps-state{font-size:12px;color:var(--dsw-alias-state-idle-primary)}',
      '.mcps-state[data-on="true"]{color:var(--dsw-alias-state-success-primary)}',
      '.mcps-code{font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:1px 6px}',
      '.mcps-switch{position:relative;flex:none;width:36px;height:20px;padding:0;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);cursor:pointer;transition:background .15s ease,border-color .15s ease}',
      '.mcps-switch[data-checked="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.mcps-switch:disabled{cursor:not-allowed;opacity:.5}',
      '.mcps-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.mcps-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:transform .15s ease}',
      '.mcps-switch[data-checked="true"] .mcps-knob{transform:translateX(16px)}',
      '.mcps-footer{display:flex;align-items:center;gap:12px}',
      '.mcps-button{font:inherit;font-size:13px;padding:5px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.mcps-button:disabled{opacity:.5;cursor:default}',
      '.mcps-hint{font-size:12px;color:var(--dsw-alias-label-secondary)}',
    ].join('');

    /** Services this plugin requires: the Settings slot list and the plugin Remote. */
    const inject = ['slots', 'locale', 'remote', 'remote.pluginManager'];

    /** Mount the Settings page and keep it current with the Host's change events. */
    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'mcp-switch: dictionaries');

      const store = createStore(ctx);
      ctx.effect(() => () => store.dispose(), 'mcp-switch: store');
      ctx.effect(() => {
        const refresh = () => {
          void store.load();
        };
        const disposers = [
          ctx.remote.$on('plugin-manager/changed', refresh),
          ctx.on('connection/reset', refresh),
        ];
        return () => {
          for (const dispose of disposers) if (typeof dispose === 'function') dispose();
        };
      }, 'mcp-switch: host invalidations');

      void store.load();

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: SECTION_ID,
            order: 16,
            label: () => t('nav'),
            locale: NS,
            inject: () => ({ store }),
          },
          McpSwitchSection,
        ),
      );
    }

    return { inject, apply };
  },
});
