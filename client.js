/**
 * Client half of @local/dsh-mcp-switch.
 *
 * Contributes one Settings page that lists every Loader row whose module is the
 * MCP client (`@deepseek-ai/dsh-mcp-client`) and switches each one through the
 * existing `pluginManager` Remote. Toggling writes the profile patch and the
 * Loader reload lifecycle applies it, so no restart is involved while HMR is
 * mounted.
 *
 * Before a switch is touched, each row can show what that server actually
 * offers: the tools it currently registers, read from the Host's own read-only
 * route (`/api/mcp-switch/servers`, contributed by this package's Host half).
 * A disabled server keeps showing the list last seen while it ran, labelled as
 * cached; the browser also persists that snapshot so a restart does not erase
 * the preview.
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
    /** Read-only Host route contributed by this package's Host half. */
    const PREVIEW_ROUTE = '/api/mcp-switch/servers';
    /** Host route that connects to one server and reads its tools. */
    const PROBE_ROUTE = '/api/mcp-switch/probe';
    /** Browser-local snapshot so a restart keeps the last preview. */
    const CACHE_KEY = 'dsh.mcp-switch.preview.v1';
    /** Bound the stored snapshot; one entry per MCP server. */
    const CACHE_LIMIT = 64;
    /** Retry delays after a toggle: MCP connect + tools/list is asynchronous. */
    const PREVIEW_RETRY_MS = [1200, 3000];

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
      showTools: 'View tools',
      hideTools: 'Hide tools',
      toolsHeading: 'Tools provided',
      cachedNote: 'Last seen while enabled',
      noToolsLive: 'This server currently registers no tools (connecting, failed, or exposing none).',
      noToolsOff: 'Enable this server to read its tool list.',
      previewUnavailable:
        'Tool preview is unavailable: the Host route is not ready, or this page is not open on the Loopback address.',
      previewLoading: 'Reading tool lists…',
      params: 'Parameters',
      none: 'none',
      probeButton: 'Read tool list',
      probing: 'Connecting and reading tools…',
      probeFailed: 'Could not read tools',
      reread: 'Read again',
      probedAt: 'read at',
      probeLive: 'live',
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
      showTools: '查看工具',
      hideTools: '收起工具',
      toolsHeading: '提供的工具',
      cachedNote: '上次启用时读到',
      noToolsLive: '该服务当前没有注册工具（可能正在连接、启动失败或不提供工具）。',
      noToolsOff: '启用该服务后会自动读取它的工具清单。',
      previewUnavailable:
        '工具预览暂不可用：Host 侧接口未就绪，或当前页面不是通过本机回环地址访问的。',
      previewLoading: '正在读取工具清单…',
      params: '参数',
      none: '无',
      probeButton: '读取工具清单',
      probing: '正在连接并读取工具…',
      probeFailed: '读取失败',
      reread: '重新读取',
      probedAt: '读取于',
      probeLive: '实时',
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

    /** Plain-object guard. */
    function isRecord(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    /** Parse one JSON response body, keeping a readable failure for plain text. */
    async function readJsonResponse(response) {
      const text = await response.text();
      if (text.trim() === '') return {};
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(text.slice(0, 200));
      }
    }

    /** Normalize one tool row from the Host preview payload. */
    function normalizeTool(raw) {
      if (!isRecord(raw) || typeof raw.name !== 'string' || raw.name === '') return void 0;
      const parameters = Array.isArray(raw.parameters)
        ? raw.parameters
            .filter((parameter) => isRecord(parameter) && typeof parameter.name === 'string')
            .map((parameter) => ({ name: parameter.name, required: parameter.required === true }))
        : [];
      return {
        name: raw.name,
        description: typeof raw.description === 'string' ? raw.description : '',
        parameters,
      };
    }

    /** Normalize one server row from the Host preview payload. */
    function normalizePreviewServer(raw) {
      if (!isRecord(raw) || typeof raw.entryId !== 'string' || raw.entryId === '') return void 0;
      const tools = Array.isArray(raw.tools) ? raw.tools.map(normalizeTool).filter(Boolean) : [];
      const cachedRaw = isRecord(raw.cached) ? raw.cached : void 0;
      const cachedTools = Array.isArray(cachedRaw?.tools)
        ? cachedRaw.tools.map(normalizeTool).filter(Boolean)
        : [];
      return {
        entryId: raw.entryId,
        serverName: typeof raw.serverName === 'string' ? raw.serverName : '',
        transport: typeof raw.transport === 'string' ? raw.transport : '',
        enabled: raw.enabled === true,
        tools,
        cached:
          cachedRaw !== void 0 && cachedTools.length > 0
            ? { tools: cachedTools, asOf: Number(cachedRaw.asOf) || 0 }
            : void 0,
      };
    }

    /** Last preview snapshot persisted in this browser (survives a restart). */
    function readPreviewCache() {
      try {
        const raw = globalThis.localStorage?.getItem(CACHE_KEY);
        if (typeof raw !== 'string' || raw === '') return {};
        const parsed = JSON.parse(raw);
        if (!isRecord(parsed)) return {};
        const cache = {};
        for (const [entryId, value] of Object.entries(parsed)) {
          if (!isRecord(value) || !Array.isArray(value.tools)) continue;
          const tools = value.tools.map(normalizeTool).filter(Boolean);
          if (tools.length === 0) continue;
          cache[entryId] = {
            serverName: typeof value.serverName === 'string' ? value.serverName : '',
            tools,
            asOf: Number(value.asOf) || 0,
          };
        }
        return cache;
      } catch {
        return {};
      }
    }

    /** Persist the preview snapshot, newest entries kept. */
    function writePreviewCache(cache) {
      try {
        const entries = Object.entries(cache)
          .sort((left, right) => (right[1].asOf || 0) - (left[1].asOf || 0))
          .slice(0, CACHE_LIMIT);
        globalThis.localStorage?.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
      } catch {
        // A full or unavailable localStorage must not break the page.
      }
    }

    /**
     * Find the preview that belongs to one row: the live Host snapshot first,
     * then this browser's cached snapshot. Rows and servers may be joined by
     * entry id, server name or patch id, because the Host route and the plugin
     * manager name the same row differently.
     */
    function previewForEntry(entry, state) {
      const rowMatches = (candidate) => {
        const entryId = typeof candidate.entryId === 'string' ? candidate.entryId : '';
        const serverName = typeof candidate.serverName === 'string' ? candidate.serverName : '';
        return (
          entryId === entry.entryId ||
          entryId.replace(/^include:/, '') === rowKey(entry) ||
          serverName === entry.name ||
          serverName === rowKey(entry)
        );
      };
      for (const candidate of Object.values(state.preview)) {
        if (rowMatches(candidate)) return candidate;
      }
      const cached = state.previewCache[entry.entryId];
      const cachedSkeleton = (value) => ({
        entryId: entry.entryId,
        serverName: value.serverName,
        transport: '',
        enabled: entry.enabled,
        tools: [],
        cached: { tools: value.tools, asOf: value.asOf },
      });
      if (cached !== void 0) return cachedSkeleton(cached);
      for (const candidate of Object.values(state.previewCache)) {
        if (rowMatches(candidate)) return cachedSkeleton(candidate);
      }
      return void 0;
    }

    /**
     * The page's data: the MCP rows the Host reports, the read-only tool
     * preview, plus one in-flight toggle. Every mutation re-reads the Host,
     * which stays the only source of truth.
     */
    function createStore(ctx) {
      let state = {
        status: 'idle',
        servers: [],
        error: '',
        notice: '',
        busy: '',
        previewStatus: 'idle',
        preview: {},
        previewCache: readPreviewCache(),
        previewError: '',
        /** entryId -> { status: 'loading' | 'ready' | 'error', ... } */
        probes: {},
      };
      const listeners = new Set();
      /** Pending preview retries (MCP connects asynchronously after a toggle). */
      const timers = new Set();
      let disposed = false;
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
        disposed = true;
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
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

      /** Read which tools each MCP server registers, from the Host's own route. */
      async function loadPreview() {
        const fetchImpl = globalThis.fetch;
        if (typeof fetchImpl !== 'function') {
          emit({ previewStatus: 'unavailable', previewError: 'fetch is unavailable' });
          return;
        }
        emit({
          previewStatus: state.previewStatus === 'ready' ? 'refreshing' : 'loading',
          previewError: '',
        });
        try {
          const response = await fetchImpl(PREVIEW_ROUTE, {
            method: 'GET',
            headers: { accept: 'application/json' },
            credentials: 'same-origin',
            cache: 'no-store',
          });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const body = await response.json();
          if (!isRecord(body) || body.ok !== true || !Array.isArray(body.servers)) {
            throw new Error('unexpected preview payload');
          }
          const preview = {};
          const cache = { ...readPreviewCache() };
          const asOf = Date.now();
          for (const raw of body.servers) {
            const server = normalizePreviewServer(raw);
            if (server === void 0) continue;
            preview[server.entryId] = server;
            if (server.tools.length > 0) {
              cache[server.entryId] = {
                serverName: server.serverName,
                tools: server.tools,
                asOf,
              };
            } else if (server.cached !== void 0) {
              cache[server.entryId] = {
                serverName: server.serverName,
                tools: server.cached.tools,
                asOf: server.cached.asOf,
              };
            }
          }
          writePreviewCache(cache);
          if (disposed) return;
          emit({ previewStatus: 'ready', preview, previewCache: cache, previewError: '' });
        } catch (error) {
          if (disposed) return;
          emit({ previewStatus: 'unavailable', previewError: messageOf(error) });
        }
      }

      /** Re-read the preview after enabling: connect + tools/list is not instant. */
      function schedulePreviewRetries() {
        if (typeof setTimeout !== 'function') return;
        for (const delay of PREVIEW_RETRY_MS) {
          const timer = setTimeout(() => {
            timers.delete(timer);
            void loadPreview();
          }, delay);
          // Browser timers ignore this; it keeps Node-based tests from idling.
          if (typeof timer?.unref === 'function') timer.unref();
          timers.add(timer);
        }
      }

      /**
       * Ask the Host to connect to one server and read its tools. Works whether
       * the server's switch is on or off; the result is cached by the Host.
       */
      async function probe(entryId, force = false) {
        if (state.probes[entryId]?.status === 'loading') return;
        emit({ probes: { ...state.probes, [entryId]: { status: 'loading' } } });
        const fetchImpl = globalThis.fetch;
        if (typeof fetchImpl !== 'function') {
          emit({
            probes: {
              ...state.probes,
              [entryId]: { status: 'error', error: 'fetch is unavailable' },
            },
          });
          return;
        }
        try {
          const response = await fetchImpl(PROBE_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            credentials: 'same-origin',
            cache: 'no-store',
            body: JSON.stringify({ entryId, force }),
          });
          const body = await readJsonResponse(response);
          if (!response.ok || !isRecord(body) || body.ok !== true || !isRecord(body.probe)) {
            throw new Error(isRecord(body) && typeof body.error === 'string' ? body.error : 'HTTP ' + response.status);
          }
          const tools = Array.isArray(body.probe.tools)
            ? body.probe.tools.map(normalizeTool).filter(Boolean)
            : [];
          if (disposed) return;
          emit({
            probes: {
              ...state.probes,
              [entryId]: {
                status: 'ready',
                tools,
                probedAt: Number(body.probe.probedAt) || Date.now(),
                serverInfo: isRecord(body.probe.serverInfo) ? body.probe.serverInfo : {},
                protocolVersion:
                  typeof body.probe.protocolVersion === 'string' ? body.probe.protocolVersion : '',
              },
            },
          });
        } catch (error) {
          if (disposed) return;
          emit({
            probes: {
              ...state.probes,
              [entryId]: { status: 'error', error: messageOf(error) },
            },
          });
        }
      }

      /** Whether one row still lacks any tool data (live, probed or cached). */
      function needsProbe(entry) {
        if (state.probes[entry.entryId] !== void 0) return false;
        const preview = previewForEntry(entry, state);
        if (preview === void 0) return true;
        if ((preview.tools?.length ?? 0) > 0) return false;
        if ((preview.probe?.tools?.length ?? 0) > 0) return false;
        if ((preview.cached?.tools?.length ?? 0) > 0) return false;
        return true;
      }

      /**
       * First visit for a server: read its tools without waiting for the user
       * to flip a switch. Sequential, so a page open never spawns several MCP
       * servers at once.
       */
      async function autoProbe() {
        if (state.previewStatus !== 'ready') return;
        for (const entry of state.servers) {
          if (disposed) return;
          if (!needsProbe(entry)) continue;
          await probe(entry.entryId, false);
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
        await loadPreview();
        emit({ busy: '', notice, error: failure });
        if (notice === 'applied' && enabled) schedulePreviewRetries();
      }

      return { getSnapshot, subscribe, dispose, load, loadPreview, probe, autoProbe, toggle };
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

    /** One row's tool list: model-facing name, parameter names, description. */
    function ToolList({ tools, t }) {
      return h(
        'ul',
        { className: 'mcps-tools' },
        tools.map((tool) =>
          h(
            'li',
            { className: 'mcps-tool', key: tool.name },
            h(
              'div',
              { className: 'mcps-tool-head' },
              h('code', { className: 'mcps-tool-name' }, tool.name),
              tool.parameters.length > 0
                ? h(
                    'span',
                    { className: 'mcps-tool-params' },
                    t('params') +
                      ': ' +
                      tool.parameters
                        .map((parameter) => (parameter.required ? parameter.name + '*' : parameter.name))
                        .join(', '),
                  )
                : null,
            ),
            tool.description !== ''
              ? h('p', { className: 'mcps-tool-desc' }, tool.description)
              : null,
          ),
        ),
      );
    }

    /** Local time text for a cached snapshot, tolerant of a bad value. */
    function formatTime(asOf) {
      if (typeof asOf !== 'number' || asOf <= 0) return '';
      try {
        return new Date(asOf).toLocaleString();
      } catch {
        return '';
      }
    }

    /** One MCP row: identity, tool preview, state, and the switch. */
    function Row({ entry, t, busy, onToggle, preview, probeState, onProbe }) {
      const [open, setOpen] = React.useState(false);
      const name = entry.name;
      const live = preview?.tools ?? [];
      const probedTools = probeState?.status === 'ready' ? probeState.tools : preview?.probe?.tools ?? [];
      const probedMeta = probeState?.status === 'ready' ? probeState : preview?.probe;
      const memoryTools = preview?.cached?.tools ?? [];
      // Live registry wins; then an explicit probe (persisted on the Host);
      // then the in-memory last-seen snapshot of a server that has since been
      // disabled.
      const source =
        live.length > 0
          ? 'live'
          : probedTools.length > 0
            ? 'probe'
            : memoryTools.length > 0
              ? 'memory'
              : 'none';
      const tools =
        source === 'live' ? live : source === 'probe' ? probedTools : source === 'memory' ? memoryTools : [];
      const loading = probeState?.status === 'loading';
      const failed = probeState?.status === 'error';
      const sourceLabel =
        source === 'live'
          ? t('probeLive')
          : source === 'probe'
            ? t('probedAt') + ' ' + formatTime(probedMeta?.probedAt)
            : source === 'memory'
              ? t('cachedNote') + ' ' + formatTime(preview?.cached?.asOf)
              : '';
      const transport = preview?.transport ?? '';
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
            transport !== '' ? h('code', { className: 'mcps-code' }, transport) : null,
          ),
          h(
            'div',
            { className: 'mcps-preview' },
            tools.length > 0
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'mcps-preview-toggle',
                    'aria-expanded': open ? 'true' : 'false',
                    onClick: () => setOpen(!open),
                  },
                  (open ? t('hideTools') : t('showTools')) +
                    ' · ' +
                    tools.length +
                    (sourceLabel !== '' ? ' · ' + sourceLabel : ''),
                )
              : loading
                ? h('span', { className: 'mcps-preview-empty' }, t('probing'))
                : h(
                    'div',
                    { className: 'mcps-preview-actions' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'mcps-preview-toggle',
                        onClick: () => {
                          void onProbe(entry.entryId, true);
                        },
                      },
                      failed ? t('reread') : t('probeButton'),
                    ),
                    failed
                      ? h(
                          'span',
                          { className: 'mcps-preview-error', title: String(probeState.error ?? '') },
                          t('probeFailed') + ': ' + String(probeState.error ?? '').slice(0, 240),
                        )
                      : h(
                          'span',
                          { className: 'mcps-preview-empty' },
                          entry.enabled ? t('noToolsLive') : t('noToolsOff'),
                        ),
                  ),
            open && tools.length > 0
              ? h(
                  'div',
                  { className: 'mcps-tools-wrap' },
                  h(
                    'div',
                    { className: 'mcps-tools-head' },
                    h(
                      'span',
                      null,
                      t('toolsHeading') + (sourceLabel !== '' ? ' · ' + sourceLabel : ''),
                    ),
                    source !== 'live'
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'mcps-link-button',
                            disabled: loading,
                            onClick: () => {
                              void onProbe(entry.entryId, true);
                            },
                          },
                          loading ? t('probing') : t('reread'),
                        )
                      : null,
                  ),
                  h(ToolList, { tools, t }),
                )
              : null,
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
      const previewDown = state.previewStatus === 'unavailable' && servers.length > 0;
      return h(
        'section',
        { className: 'mcps-section' },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        h('h2', { className: 'mcps-title' }, t('title')),
        h('p', { className: 'mcps-intro' }, t('intro')),
        state.error !== '' ? h('p', { className: 'mcps-error', role: 'alert' }, state.error) : null,
        state.notice !== '' ? h('p', { className: 'mcps-notice' }, t(state.notice)) : null,
        previewDown
          ? h(
              'p',
              { className: 'mcps-warn', title: state.previewError },
              t('previewUnavailable') +
                (state.previewError !== '' ? '（' + state.previewError + '）' : ''),
            )
          : null,
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
                  preview: previewForEntry(entry, state),
                  probeState: state.probes[entry.entryId],
                  onProbe: store.probe,
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
                void store.loadPreview();
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
      '.mcps-warn{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
      '.mcps-empty{margin:0;font-size:13px;color:var(--dsw-alias-label-secondary)}',
      '.mcps-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}',
      '.mcps-row{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}',
      '.mcps-info{min-width:0;flex:1;display:flex;flex-direction:column;gap:4px}',
      '.mcps-name{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.mcps-desc{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.mcps-meta{display:flex;align-items:center;flex-wrap:wrap;gap:8px}',
      '.mcps-state{font-size:12px;color:var(--dsw-alias-state-idle-primary)}',
      '.mcps-state[data-on="true"]{color:var(--dsw-alias-state-success-primary)}',
      '.mcps-code{font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:1px 6px}',
      '.mcps-preview{display:flex;flex-direction:column;gap:6px;margin-top:2px}',
      '.mcps-preview-toggle{align-self:flex-start;font:inherit;font-size:12px;padding:3px 9px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.mcps-preview-toggle:hover{border-color:var(--dsw-alias-border-l3)}',
      '.mcps-preview-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.mcps-preview-empty{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.mcps-preview-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
      '.mcps-preview-error{font-size:12px;color:var(--dsw-alias-label-error);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mcps-tools-wrap{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}',
      '.mcps-tools-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.mcps-link-button{font:inherit;font-size:12px;font-weight:400;padding:0;border:0;background:none;color:var(--dsw-alias-brand-primary);cursor:pointer}',
      '.mcps-link-button:disabled{opacity:.6;cursor:default}',
      '.mcps-tools{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;max-height:360px;overflow:auto}',
      '.mcps-tool{display:flex;flex-direction:column;gap:2px}',
      '.mcps-tool-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px}',
      '.mcps-tool-name{font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:1px 6px}',
      '.mcps-tool-params{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.mcps-tool-desc{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word}',
      '.mcps-switch{position:relative;flex:none;margin-top:2px;width:36px;height:20px;padding:0;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);cursor:pointer;transition:background .15s ease,border-color .15s ease}',
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
          void store.load()
            .then(() => store.loadPreview())
            .then(() => store.autoProbe());
        };
        const disposers = [
          ctx.remote.$on('plugin-manager/changed', refresh),
          ctx.on('connection/reset', refresh),
        ];
        return () => {
          for (const dispose of disposers) if (typeof dispose === 'function') dispose();
        };
      }, 'mcp-switch: host invalidations');

      void store.load()
        .then(() => store.loadPreview())
        .then(() => store.autoProbe());

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
