/**
 * Client half of dsh-workspace-control.
 *
 * Adds one row to the per-session "..." menu in the workspace sidebar and a
 * dialog that moves that session to another working directory.
 *
 * The dialog talks to the Host half through a plugin-owned Typert Remote
 * namespace: the Host registers descriptors with `ctx.typert.register(...)` and
 * the Client mounts the same descriptors with `ctx.remote.$mount(...)`, then
 * calls `ctx.remote.workspaceControl.move(...)`.
 */

function build(require) {
  const React = require('react');
    const h = React.createElement;

    const PACKAGE = 'dsh-workspace-control';
    const NAMESPACE = 'workspaceControl';
    const SLOT = 'sidebar.workspaces.session.menu.item';
    const SETTINGS = 'settings.section';
    const OVERLAY = 'shell.overlay';
    const MAIN = 'main';
    const PANEL = 'sidebar.panellist';
    const PANEL_KEY = 'workspace-control';

    // One place for the numbers and tones the UI repeats: a result banner lives
    // for a moment, and every accent is the same three channels.
    const DISMISS_MS = 6000;
    const ACCENT_RGB = '88,101,242';
    const WARN_RGB = '240,180,80';
    const DANGER_RGB = '255,120,120';
    const DANGER_TEXT = '#ff8f8f';

    /* ------------------------------------------------------------- contract */

    const codec = (name, parse) => ({
      mode: 'strict',
      typeSymbol: `${PACKAGE}#${name}`,
      create: () => ({ parse }),
    });

    const jsonValue = (name) => codec(name, (value) => value);

    const nonEmptyString = (name) =>
      codec(name, (value) => {
        if (typeof value !== 'string' || value.trim() === '') {
          throw new Error('Expected a non-empty string');
        }
        return value.trim();
      });

    const sessionIdCodec = nonEmptyString('SessionId');
    const targetCodec = nonEmptyString('TargetDirectory');
    const workspaceIdCodec = nonEmptyString('WorkspaceId');
    const titleCodec = nonEmptyString('WorkspaceTitle');
    const booleanCodec = codec('Flag', (value) => {
      if (value === undefined || value === null) return false;
      if (typeof value !== 'boolean') throw new Error('Expected a boolean');
      return value;
    });
    const workspaceIdsCodec = codec('WorkspaceIdList', (value) => {
      if (!Array.isArray(value) || value.length === 0) {
        throw new Error('Expected a non-empty array of workspace ids');
      }
      return value.map((entry) => {
        if (typeof entry !== 'string' || entry.trim() === '') {
          throw new Error('Expected every workspace id to be a non-empty string');
        }
        return entry.trim();
      });
    });

    function method(name, parameters) {
      return {
        id: `${PACKAGE}#${NAMESPACE}/${name}`,
        service: NAMESPACE,
        namespace: NAMESPACE,
        method: name,
        invocation: { kind: 'direct' },
        result: jsonValue('WorkspaceControlResult'),
        parameters: parameters.map((parameter) => ({
          name: parameter.wire,
          wire: parameter.wire,
          source: 'json',
          codec: parameter.codec,
        })),
      };
    }

    const DESCRIPTORS = Object.freeze([
      method('inspect', [{ wire: 'sessionId', codec: sessionIdCodec }]),
      method('move', [
        { wire: 'sessionId', codec: sessionIdCodec },
        { wire: 'target', codec: targetCodec },
      ]),
      method('listWorkspaces', []),
      method('rebuildWorkspace', [
        { wire: 'workspaceId', codec: workspaceIdCodec },
        { wire: 'target', codec: targetCodec },
      ]),
      method('mergeWorkspaces', [
        { wire: 'workspaceId', codec: workspaceIdCodec },
        { wire: 'sourceIds', codec: workspaceIdsCodec },
      ]),
      method('retitleWorkspace', [
        { wire: 'workspaceId', codec: workspaceIdCodec },
        { wire: 'title', codec: titleCodec },
      ]),
      method('removeWorkspace', [
        { wire: 'workspaceId', codec: workspaceIdCodec },
        { wire: 'keepSessions', codec: booleanCodec },
      ]),
      // Diagnostics the panel never calls but the contract test (and any console
      // debugging) needs mounted, so Client and Host stay one list.
      method('probeAgent', [{ wire: 'sessionId', codec: sessionIdCodec }]),
      method('releaseSession', [{ wire: 'sessionId', codec: sessionIdCodec }]),
      method('probeRestart', []),
      method('restart', [{ wire: 'force', codec: booleanCodec }]),
    ]);

    const REMOTE = Object.freeze({ package: PACKAGE, descriptors: DESCRIPTORS });

    /* --------------------------------------------------------------- locale */

    const ZH = typeof navigator !== 'undefined' && /^zh/i.test(navigator.language || '');

    const TEXT = {
      move: { zh: '移动到工作区…', en: 'Move to workspace…' },
      title: { zh: '移动到工作区', en: 'Move to workspace' },
      current: { zh: '当前目录', en: 'Current directory' },
      target: { zh: '目标目录', en: 'Target directory' },
      placeholder: {
        zh: '绝对路径，例如 D:\\Github\\my-workspace',
        en: 'Absolute path, e.g. D:\\Github\\my-workspace',
      },
      browse: { zh: '选择目录…', en: 'Choose…' },
      confirm: { zh: '移动', en: 'Move' },
      cancel: { zh: '取消', en: 'Cancel' },
      close: { zh: '关闭', en: 'Close' },
      working: { zh: '正在移动…', en: 'Moving…' },
      loading: { zh: '正在读取会话…', en: 'Reading session…' },
      hint: {
        zh: '历史、标题与工具调用会一并保留。移动完成后刷新页面即可看到结果，不需要重启。',
        en: 'History, title and tool records are preserved. Refresh the page after the move; no restart is needed.',
      },
      reload: { zh: '刷新页面', en: 'Reload page' },
      restart: {
        zh: '文件已经就位，但工作区归属还没落定。再执行一次同样的移动即可补齐。',
        en: 'The files are in place but the membership did not settle. Run the same move once more to finish it.',
      },
      needTarget: { zh: '请先选择一个目标目录。', en: 'Choose a target directory first.' },
      rebuild: { zh: '重建…', en: 'Rebuild…' },
      merge: { zh: '合并…', en: 'Merge…' },
      rebuildTitle: { zh: '重建工作区', en: 'Rebuild workspace' },
      mergeTitle: { zh: '合并工作区', en: 'Merge workspaces' },
      newDir: { zh: '新目录', en: 'New directory' },
      pickSources: { zh: '选择要合并进来的工作区', en: 'Select the workspaces to fold in' },
      sessionCount: { zh: '个会话', en: 'sessions' },
      noWorkspaces: { zh: '没有读到工作区。', en: 'No workspace was read.' },
      doRebuild: { zh: '重建', en: 'Rebuild' },
      doMerge: { zh: '合并', en: 'Merge' },
      rebuilding: { zh: '正在重建…', en: 'Rebuilding…' },
      merging: { zh: '正在合并…', en: 'Merging…' },
      needSource: { zh: '请先选择要合并的工作区。', en: 'Select at least one workspace to merge.' },
      refreshList: { zh: '刷新列表', en: 'Refresh' },
      restartButton: { zh: '重启 DSH', en: 'Restart DSH' },
      restartAndMove: { zh: '重启并完成移动', en: 'Restart and finish moving' },
      restartTitle: { zh: '重启 DSH', en: 'Restart DSH' },
      restartHint: {
        zh: '重启会关闭当前窗口并自动重新打开；所有会话都会保留，正在生成的那一轮会中断。被应用打开着的会话只有在重启后才会释放写句柄，所以移动被挡住时用这里。',
        en: 'The window closes and reopens by itself. Every session is kept; a turn that is still producing is interrupted. A session the app has open releases its write handle only after a restart, so this is the way past a blocked move.',
      },
      restartRunning: {
        zh: '当前有 {n} 个会话正在运行，重启会打断它们。',
        en: '{n} session(s) are mid-turn; the restart interrupts them.',
      },
      restartUnsupported: {
        zh: '这个构建不能自己重启（例如 dsh web 没有桌面外壳），请手动退出后再启动。',
        en: 'This build cannot restart itself (a plain dsh web server has no desktop shell); quit and start it again by hand.',
      },
      restarting: { zh: '正在重启…', en: 'Restarting…' },
      doRestart: { zh: '立即重启', en: 'Restart now' },
      back: { zh: '返回', en: 'Back' },
      code: {
        moved: { zh: '会话已移动。', en: 'The session moved.' },
        attached: {
          zh: '会话已在该目录，工作区归属和标题缓存都补齐了。刷新页面即可看到。',
          en: 'The session was already in this directory; its membership and cached title are now repaired. Refresh to see it.',
        },
        'moved-unattached': {
          zh: '会话文件已移动，但工作区还没接收它。',
          en: 'The session file moved, but the workspace has not accepted it yet.',
        },
        'workspace-unattached': {
          zh: '工作区没有接收这个会话，其他内容未改动。',
          en: 'The workspace did not accept this session; nothing else was changed.',
        },
        'moved-unverified': {
          zh: '会话文件已写入新目录，但回读校验未通过。请刷新后确认。',
          en: 'The session file was written to the new directory, but the read-back check did not match. Refresh and verify.',
        },
        'not-absolute': { zh: '目标必须是绝对路径。', en: 'The target must be an absolute path.' },
        'missing-target': { zh: '目标目录不存在。', en: 'The target directory does not exist.' },
        unwritable: { zh: '目标目录不可写。', en: 'The target directory is not writable.' },
        running: {
          zh: '这一轮还在生成中，等它跑完再移动。',
          en: 'A turn is still running for this session; wait for it to finish, then move it.',
        },
        'no-cwd': { zh: '这个会话没有记录工作目录。', en: 'This session has no recorded working directory.' },
        'same-path': { zh: '目标目录就是当前目录。', en: 'The target is already the current directory.' },
        retitled: {
          zh: '工作区名字现在是目录名了，刷新页面即可看到。',
          en: 'The workspace title now follows its directory. Refresh to see it.',
        },
        'retitle-failed': { zh: '改名失败了。', en: 'The title could not be changed.' },
        unreadable: { zh: '会话存储无法读取。', en: 'The stored session could not be read.' },
        'artifact-missing': {
          zh: '找不到会话存储文件，未做任何修改。',
          en: 'The session file could not be located; nothing was changed.',
        },
        'write-failed': { zh: '写入失败。', en: 'The write failed.' },
        'rollback-failed': {
          zh: '写入失败，回滚也失败了。请检查会话存储目录后再操作。',
          en: 'The write failed and the rollback failed too. Inspect the session store before continuing.',
        },
        'empty-log': {
          zh: '这个会话还没有已提交的记录。先打开它一次，再移动。',
          en: 'This session has no committed records yet. Open it once, then move it.',
        },
        'store-cached': {
          zh: '会话存储仍把它算在旧位置，未做任何修改。重启 DSH 后再试。',
          en: 'The session store still counts it in the old place, so nothing changed. Restart DSH and try again.',
        },
        busy: { zh: '这个会话已有一个移动操作在进行。', en: 'A move for this session is already running.' },
        'session-open': {
          zh: '会话还被应用持有，日志无法重新发布。DSH 只在退出时释放它。',
          en: 'The app still holds this session, so its log cannot be re-published. DSH releases it only when the app exits.',
        },
        'held-restart': {
          zh: '会话还被应用持有，现在无法重新发布日志。移动已排队：点下面的按钮重启 DSH，启动时会自动完成。',
          en: 'The app still holds this session, so its log cannot be re-published yet. The move is queued: restart DSH below and it finishes during startup.',
        },
        'sessions-open': {
          zh: '这个工作区里有会话还被应用持有。DSH 只在退出时释放它们；正在跑一轮的会话同样会被拒绝。',
          en: 'Some sessions here are still held open by the app. DSH releases them only when it exits; a session mid-turn is refused too.',
        },
        restarted: { zh: '已发起重启，窗口会自动重开。', en: 'Restart requested; the window reopens on its own.' },
        'restart-unsupported': {
          zh: '这个构建不能自己重启，请手动退出后再启动。',
          en: 'This build cannot restart itself; quit and start it again by hand.',
        },
        rebuilt: {
          zh: '工作区已重建，会话都跟着搬过去了。刷新页面即可看到。',
          en: 'The workspace was rebuilt and its sessions moved with it. Refresh to see it.',
        },
        merged: {
          zh: '合并完成，会话都挂到这个工作区了。刷新页面即可看到。',
          en: 'Merged; the sessions now belong to this workspace. Refresh to see them.',
        },
        'merged-partial': {
          zh: '部分会话已合并，其余没能移动（原因见下）。',
          en: 'Some sessions merged; the rest could not be moved (reason below).',
        },
        'merge-failed': { zh: '一个会话都没能合并。', en: 'No session could be merged.' },
        'rebuild-failed': {
          zh: '重建中途失败，已移动的会话都放回原处了。',
          en: 'The rebuild stopped part-way; the sessions already moved were put back.',
        },
        'sessions-running': {
          zh: '这个工作区里有会话正在生成中，等它们跑完再操作。',
          en: 'A session in this workspace is mid-turn; wait for it to finish.',
        },
        'nothing-to-merge': { zh: '所选工作区里没有已存会话。', en: 'The selected workspaces hold no stored sessions.' },
        'no-source': { zh: '没有选择其它工作区。', en: 'No other workspace was selected.' },
        'target-is-workspace': {
          zh: '那个目录已经是另一个工作区，请改用「合并」。',
          en: 'That directory already is another workspace — merge into it instead.',
        },
        'registry-unavailable': { zh: '工作区列表读不到。', en: 'The workspace registry could not be read.' },
        'not-found': { zh: '这个工作区已经不存在了。', en: 'That workspace no longer exists.' },
        'needs-migration': {
          zh: '这个会话仍是旧格式。先打开它让 DSH 完成升级，再移动。',
          en: 'This session still uses an older format. Open it once so DSH upgrades it, then move it.',
        },
        'not-ready': {
          zh: '插件启动时出错了，功能暂时不可用。详情见插件日志。',
          en: 'The plugin failed to start, so this is unavailable. See the plugin log for details.',
        },
        'verify-failed': {
          zh: '写入后的日志校验不通过，已放弃并还原原件。',
          en: 'The written log did not verify, so it was discarded and the original restored.',
        },
        'archive-failed': {
          zh: '归档会话失败，工作区没有删除。',
          en: 'The sessions could not be archived, so the workspace was kept.',
        },
        'moved-unreprojected': {
          zh: '会话已移动，但标题缓存没能刷新。刷新页面即可重新生成。',
          en: 'The session moved, but its title cache could not be refreshed. Refresh the page to rebuild it.',
        },
        'attached-unreprojected': {
          zh: '工作区归属已补齐，但标题缓存没能刷新。刷新页面即可。',
          en: 'Membership was repaired, but the title cache could not be refreshed. Refresh the page.',
        },
        keepSessions: {
          zh: '保留会话（只删除工作区记录，会话仍会归档保留）',
          en: 'Keep the sessions (only the workspace record is removed; sessions stay archived)',
        },
        degraded: {
          zh: '当前 DSH 版本里部分修复能力不可用，重建/合并仍可用，但占用释放与索引刷新可能降级。',
          en: 'Some repair capabilities are unavailable in this DSH build. Rebuild and merge still work, but holder release and index refresh may be degraded.',
        },
        removed: { zh: '工作区已删除（目录与文件保留）。', en: 'The workspace was removed (directory and files kept).' },
        'remove-failed': { zh: '工作区记录没能删除。', en: 'The workspace record could not be removed.' },
        'invalid-title': { zh: '名称不能为空。', en: 'The name cannot be empty.' },
        unknown: { zh: '未知结果。', en: 'Unknown result.' },
      },
    };

    Object.assign(TEXT, {
      panelTitle: { zh: '工作区管理', en: 'Workspaces' },
      workspacesLabel: { zh: '{n} 个工作区', en: '{n} workspaces' },
      panelHint: {
        zh: '重建：把整个工作区换到新目录，里面的会话一起搬过去。合并：把别的工作区的会话并进来。重命名：只改侧栏名称。删除：移除这条工作区记录（目录与文件保留）。',
        en: 'Rebuild moves a whole workspace to a new directory with its sessions. Merge folds other workspaces in. Rename only changes the sidebar name. Delete removes the record; the directory and its files stay.',
      },
      rename: { zh: '重命名', en: 'Rename' },
      renameTitle: { zh: '重命名工作区', en: 'Rename workspace' },
      renameLabel: { zh: '新名称', en: 'New name' },
      doRename: { zh: '保存', en: 'Save' },
      renaming: { zh: '正在保存…', en: 'Saving…' },
      needTitle: { zh: '名称不能为空。', en: 'The name cannot be empty.' },
      settingsTitle: { zh: '工作区管理', en: 'Workspaces' },
      settingsHint: {
        zh: '集中管理工作区：重建到新目录、合并、重命名、删除。占用状态会在操作前就标出来。',
        en: 'Rebuild to a new directory, merge, rename or delete workspaces. Session occupancy is shown before you act.',
      },
      openPanel: { zh: '打开工作区管理', en: 'Open workspaces' },
      remove: { zh: '删除', en: 'Delete' },
      removeTitle: { zh: '删除工作区', en: 'Delete workspace' },
      removeHint: {
        zh: '只移除侧栏里的这条工作区记录，目录和会话文件都会留在磁盘上，之后还能重新添加回来。里面的会话会先被归档。',
        en: 'This removes only the sidebar record: the directory and its session files stay on disk and the workspace can be added back later. Its sessions are archived first.',
      },
      doRemove: { zh: '删除工作区', en: 'Delete workspace' },
      removing: { zh: '正在删除…', en: 'Deleting…' },
      runningChip: { zh: '{n} 运行中', en: '{n} running' },
      openChip: { zh: '{n} 已打开 · 空闲', en: '{n} open · idle' },
      openHint: {
        zh: '这些会话只是被应用打开着，并没有在跑。但应用持有它们的写句柄，DSH 只在退出时释放——所以它们现在还不能搬。',
        en: 'These sessions are merely open, not mid-turn — but the app holds their write handle and DSH releases it only on exit, so they cannot be moved yet.',
      },
      busyHint: {
        zh: '这些会话正在跑一轮，要等它结束才能搬；被应用打开着的同样要等它被释放（只在 DSH 退出时）。',
        en: 'These sessions are mid-turn and have to finish first; open ones stay held until DSH exits.',
      },
      missingDir: { zh: '目录不存在', en: 'missing folder' },
      noOtherWorkspace: { zh: '没有其他工作区可以合并。', en: 'There is no other workspace to merge.' },
    });

    /**
     * The live UI language, read from the Client locale service at call time.
     * `navigator.language` is only a fallback: it describes the OS, while the
     * harness language is what the rest of the interface is rendered in.
     */
    function activeLang() {
      try {
        const service = ctxRef && ctxRef.locale;
        const snapshot =
          service && typeof service.getLocale === 'function' ? service.getLocale() : null;
        const id = snapshot && typeof snapshot.active === 'string' ? snapshot.active : '';
        if (id) return /^zh/i.test(id) ? 'zh' : 'en';
      } catch {
        /* fall through to the browser language */
      }
      return ZH ? 'zh' : 'en';
    }

    const pick = (entry) => {
      if (!entry) return undefined;
      const language = activeLang();
      return entry[language] || entry.en || entry.zh;
    };

    const t = (key) => pick(TEXT[key]) || key;
    const codeText = (code) => pick(TEXT.code[code]) || code;

    // Single source of truth for result text: everything lives in `TEXT.code`
    // above. A second `Object.assign(TEXT.code, …)` used to shadow half of it.

    const NS = 'dsh-workspace-control';

    function flatten(lang) {
      const dictionary = {};
      for (const [key, value] of Object.entries(TEXT)) {
        if (key === 'code') {
          for (const [code, entry] of Object.entries(value)) dictionary[`code.${code}`] = entry[lang];
        } else {
          dictionary[key] = value[lang];
        }
      }
      return dictionary;
    }

    /* ---------------------------------------------------------------- store */

    const store = {
      open: false,
      mode: 'session',
      sessionId: null,
      displayTitle: '',
      phase: 'idle',
      info: null,
      target: '',
      result: null,
      error: null,
      // workspace manager state
      workspaces: null,
      workspaceId: null,
      picks: [],
      panelView: 'list',
      titleText: '',
      // What `probeRestart` reported: whether this build can restart itself and
      // which sessions a restart would interrupt.
      restartInfo: null,
      // Whether removing a workspace keeps its sessions archived (default) or
      // leaves them in place. The panel exposes it on the confirm view.
      keepSessions: false,
      // Host-reported capability flags; a false one means the build changed and
      // some repairs fell back to a degraded path.
      internals: null,
    };

    const listeners = new Set();
    const emit = () => {
      for (const listener of listeners) listener();
    };
    let dismissTimer = null;

    const patch = (changes) => {
      Object.assign(store, changes);
      emit();
      // A result that never clears reads as a stuck dialog, so terminal results
      // retire on their own; anything that replaces them cancels the timer.
      if ('result' in changes) {
        if (changes.result) armDismiss(DISMISS_MS);
        else cancelDismiss();
      }
    };

    function useStore() {
      const [, force] = React.useState(0);
      React.useEffect(() => {
        const listener = () => force((value) => value + 1);
        listeners.add(listener);
        return () => listeners.delete(listener);
      }, []);
      return store;
    }

    /* ------------------------------------------------------------------- api */

    // The gateway may apply after this plugin, so nothing is captured eagerly:
    // `ctx` is kept and the namespace is mounted on first use.
    let ctxRef = null;
    let mountPromise = null;

    const remoteRoot = () => {
      const remote = ctxRef && ctxRef.remote;
      return remote && typeof remote === 'object' ? remote : null;
    };

    /**
     * Read an optional Client Service. Cordis throws on reading an
     * uninjected service key, so an optional dependency goes through `ctx.get`.
     */
    const optionalService = (ctx, key) => {
      try {
        return ctx && typeof ctx.get === 'function' ? ctx.get(key) : undefined;
      } catch {
        return undefined;
      }
    };

    const describeError = (error) => {
      if (error && typeof error.message === 'string' && error.message) return error.message;
      try {
        return JSON.stringify(error);
      } catch {
        return String(error);
      }
    };

    // Mount state is remembered so a failed mount shows up verbatim in the
    // dialog instead of looking like an unreadable session store.
    let mountFailure = null;
    let mountSucceeded = false;
    let mountValue;
    // Cordis gates service reads behind `inject`, so the namespace is also
    // observed through a scoped inject: once `remote.<namespace>` exists, that
    // scope may read it without the plugin-wide inject list naming it.
    let scopedCtx = null;

    function armScopedInject(ctx) {
      if (!ctx || typeof ctx.inject !== 'function') return;
      try {
        ctx.inject([`remote.${NAMESPACE}`], (scope) => {
          scopedCtx = scope;
          return () => {
            if (scopedCtx === scope) scopedCtx = null;
          };
        });
      } catch {
        /* the read chain below still reports the truth */
      }
    }

    async function ensureNamespace() {
      const remote = remoteRoot();
      if (!remote) return null;
      if (typeof remote.$mount === 'function') {
        if (!mountPromise) {
          mountFailure = null;
          mountSucceeded = false;
          mountValue = undefined;
          mountPromise = Promise.resolve(remote.$mount(REMOTE)).then(
            (value) => {
              mountSucceeded = true;
              mountValue = value;
              return remote;
            },
            (error) => {
              mountFailure = describeError(error);
              mountPromise = null;
              throw error;
            },
          );
        }
        try {
          await mountPromise;
        } catch (error) {
          throw new Error(`could not mount the workspace-control endpoint: ${describeError(error)}`);
        }
      }
      return remote;
    }

    /**
     * Read the mounted namespace. Cordis denies unknown service keys, so every
     * read is isolated and its outcome is kept for the failure message.
     */
    function readNamespace(remote) {
      const attempts = [];
      const tryRead = (label, read) => {
        try {
          const value = read();
          if (value) return value;
          attempts.push(`${label}: empty`);
        } catch (error) {
          attempts.push(`${label}: ${describeError(error)}`);
        }
        return null;
      };

      let namespace = null;
      if (scopedCtx) {
        namespace = tryRead('scoped inject', () => scopedCtx.remote && scopedCtx.remote[NAMESPACE]);
      }
      if (!namespace && mountValue) namespace = tryRead('mount result', () => mountValue[NAMESPACE]);
      if (!namespace && remote) namespace = tryRead(`remote.${NAMESPACE}`, () => remote[NAMESPACE]);
      if (!namespace && ctxRef) {
        namespace = tryRead('ctx.get', () => optionalService(ctxRef, `remote.${NAMESPACE}`));
      }
      return { namespace, attempts };
    }

    async function callRemote(method, ...args) {
      const remote = await ensureNamespace();
      const { namespace, attempts } = readNamespace(remote);
      if (!namespace || typeof namespace[method] !== 'function') {
        const detail = [
          `mount ${mountSucceeded ? 'ok' : 'not run'}${mountFailure ? ` (${mountFailure})` : ''}`,
          attempts.length ? attempts.join(' | ') : 'no read attempted',
        ].join('; ');
        throw new Error(`the ${NAMESPACE} endpoint is not callable — ${detail}`);
      }
      return namespace[method](...args);
    }

    // The gateway answers `{ ok: true, value }` / `{ ok: false, error }`, but a
    // direct (unmounted) transport hands back the bare value. Accept both so a
    // successful call is never mistaken for a failure.
    const unwrap = (response) => {
      if (response && typeof response === 'object' && 'ok' in response) return response;
      return { ok: true, value: response === undefined ? null : response };
    };

    const reasonText = (reason) => {
      if (!reason) return 'error';
      if (typeof reason === 'string') return reason;
      return String(reason.message || reason.code || reason.reason || 'error');
    };

    /**
     * Fold one remote answer into `{ value }`, `{ refusal }` or `{ error }`.
     *
     * Two shapes arrive: the gateway envelope (`{ ok, value }` / `{ ok, error }`)
     * and the bare value. The Host marks every refusal with `status: 'error'`
     * plus a stable `code`, so success is never inferred from the payload shape.
     */
    function settle(response) {
      const envelope = unwrap(response);
      if (!envelope.ok) return { error: reasonText(envelope.error || envelope.reason || envelope.message) };
      const value = envelope.value;
      if (value && typeof value === 'object' && value.status === 'error') return { refusal: value };
      return { value };
    }

    // One code table decides the accent everywhere: the result card, the dialog
    // banner and the auto-dismiss rule all read from these two sets.
    const OK_CODES = new Set(['moved', 'attached', 'rebuilt', 'merged', 'retitled', 'removed']);
    const PARTIAL_CODES = new Set([
      'moved-unverified',
      'moved-unattached',
      'moved-unreprojected',
      'attached-unreprojected',
      'merged-partial',
    ]);
    const outcomeOf = (value) => {
      const code = value && value.code;
      if (OK_CODES.has(code)) return 'ok';
      if (PARTIAL_CODES.has(code)) return 'partial';
      return 'error';
    };

    /* -------------------------------------------------------------- components */

    let primitivesCache;

    function readPrimitives() {
      if (primitivesCache === undefined) {
        try {
          primitivesCache = require('@deepseek-ai/dsh-client-ui-primitives') || null;
        } catch {
          primitivesCache = null;
        }
      }
      return primitivesCache;
    }

    /**
     * Prefer the UI-localized label the slot hands the component; fall back to
     * the tiny built-in table so a missing locale namespace never blanks a row.
     */
    const tr = (props, key) => {
      // The built-in table follows the live locale itself, so it wins; the
      // slot-injected `t` is only consulted for keys this table does not have.
      if (TEXT[key]) return t(key);
      if (props && typeof props.t === 'function') {
        try {
          const value = props.t(key);
          if (typeof value === 'string' && value !== key) return value;
        } catch {
          /* fall through to the key itself */
        }
      }
      return key;
    };

    /**
     * `useMenuOpenState` is a slot-injected hook returning `[open, setOpen]`.
     * It must be called during render, never inside the click handler.
     */
    function useMenuDismiss(props) {
      const hook = props && props.useMenuOpenState;
      const state = typeof hook === 'function' ? hook() : undefined;
      return () => {
        try {
          if (Array.isArray(state) && typeof state[1] === 'function') state[1](false);
          else if (typeof state === 'function') state(false);
          else if (state && typeof state.close === 'function') state.close();
        } catch {
          /* outside clicks close the menu as well */
        }
      };
    }

    function MenuRow(props) {
      const dismiss = useMenuDismiss(props);
      const [hover, setHover] = React.useState(false);
      // The same live chain the sidebar pill uses: an idle-but-open session must
      // not be reported as running here either.
      const liveOf = liveRunReader(props);
      let hint = null;
      try {
        hint = liveOf(props.sessionId);
      } catch {
        hint = null;
      }
      const onSelect = () => {
        dismiss();
        openDialog(props.sessionId, props.displayTitle, hint);
      };
      const primitives = readPrimitives();
      const MenuItemButton = primitives && primitives.MenuItemButton;
      if (typeof MenuItemButton === 'function') {
        return h(MenuItemButton, { separatorBefore: true, onSelect }, tr(props, 'move'));
      }
      const onClick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        onSelect();
      };
      return h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          onClick,
          onMouseDown: (event) => event.stopPropagation(),
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: '100%',
            padding: '6px 10px',
            border: 0,
            borderRadius: 6,
            background: hover ? 'var(--dsh-surface-hover, rgba(127,127,127,0.16))' : 'transparent',
            color: 'inherit',
            font: 'inherit',
            textAlign: 'left',
            cursor: 'pointer',
          },
        },
        h(
          'svg',
          {
            viewBox: '0 0 16 16',
            width: 14,
            height: 14,
            'aria-hidden': true,
            style: { flex: '0 0 auto', opacity: 0.75 },
          },
          h('path', {
            d: 'M2.5 4.5h4l1.2 1.5h5.8v6.2a.8.8 0 0 1-.8.8H3.3a.8.8 0 0 1-.8-.8z',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.2,
            strokeLinejoin: 'round',
          }),
          h('path', {
            d: 'M9.4 7.2v3.2M7.8 8.8l1.6-1.6 1.6 1.6',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.2,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
        ),
        h('span', null, tr(props, 'move')),
      );
    }

    const scrimStyle = {
      position: 'fixed',
      inset: 0,
      zIndex: 60,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(8,8,10,0.45)',
      backdropFilter: 'blur(2px)',
    };

    const cardStyle = {
      width: 'min(480px, calc(100vw - 32px))',
      boxSizing: 'border-box',
      padding: '18px 20px 16px',
      borderRadius: 12,
      background: 'var(--dsh-surface-raised, #1b1b1f)',
      color: 'var(--dsh-text, #ececf1)',
      border: '1px solid var(--dsh-border, rgba(255,255,255,0.1))',
      boxShadow: '0 18px 48px rgba(0,0,0,0.45)',
      fontSize: 13,
      lineHeight: 1.5,
    };

    const labelStyle = {
      display: 'block',
      marginBottom: 4,
      fontSize: 11,
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
      opacity: 0.55,
    };

    const inputStyle = {
      flex: '1 1 auto',
      width: 'auto',
      minWidth: 0,
      boxSizing: 'border-box',
      padding: '7px 9px',
      borderRadius: 8,
      border: '1px solid var(--dsh-border, rgba(255,255,255,0.14))',
      background: 'var(--dsh-input, rgba(255,255,255,0.05))',
      color: 'inherit',
      font: 'inherit',
    };

    const buttonStyle = (primary, disabled) => ({
      padding: '6px 14px',
      borderRadius: 8,
      border: primary ? '0' : '1px solid var(--dsh-border, rgba(255,255,255,0.16))',
      background: primary ? (disabled ? 'rgba(88,101,242,0.4)' : '#5865f2') : 'transparent',
      color: primary ? '#ffffff' : 'inherit',
      font: 'inherit',
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.65 : 1,
      whiteSpace: 'nowrap',
      flexShrink: 0,
    });

    const monoStyle = {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 12,
      wordBreak: 'break-all',
      opacity: 0.9,
    };

    function Dialog() {
      const state = useStore();
      if (!state.open) return null;

      const busy = state.phase === 'moving';
      const titleId = `wsm-dialog-title-${state.sessionId || 'none'}`;
      const cardRef = React.useRef(null);

      // A modal dialog owes the user three things the browser does not give for
      // free: focus lands inside, Tab cannot escape to the page behind it, and
      // Escape closes it from anywhere (not only from the path field).
      React.useEffect(() => {
        const node = cardRef.current;
        if (!node) return undefined;
        const previous = typeof document !== 'undefined' ? document.activeElement : null;
        const focusables = () =>
          Array.from(node.querySelectorAll('button, input, select, textarea, [href]')).filter(
            (element) => !element.disabled,
          );
        const onKeyDown = (event) => {
          if (event.key === 'Escape' && !busy) {
            event.stopPropagation();
            close();
            return;
          }
          if (event.key !== 'Tab') return;
          const items = focusables();
          if (items.length === 0) return;
          const head = items[0];
          const tail = items[items.length - 1];
          if (event.shiftKey && (document.activeElement === head || !node.contains(document.activeElement))) {
            event.preventDefault();
            tail.focus();
          } else if (!event.shiftKey && (document.activeElement === tail || !node.contains(document.activeElement))) {
            event.preventDefault();
            head.focus();
          }
        };
        node.addEventListener('keydown', onKeyDown);
        const first = focusables()[0];
        if (first && typeof first.focus === 'function') first.focus();
        return () => {
          node.removeEventListener('keydown', onKeyDown);
          if (previous && typeof previous.focus === 'function') previous.focus();
        };
        // Re-arm per session and per phase so a re-render never loses the trap.
      }, [state.sessionId, state.phase, busy]);

      const ready = state.phase === 'ready' || state.phase === 'moving';
      const canMove = ready && !busy && state.target.trim() !== '';

      const onTarget = (event) => patch({ target: event.target.value });

      const browse = async () => {
        try {
          const uiWorkspace = optionalService(ctxRef, 'uiWorkspace');
          if (uiWorkspace && typeof uiWorkspace.pickDirectory === 'function') {
            const picked = await uiWorkspace.pickDirectory();
            if (typeof picked === 'string' && picked) patch({ target: picked });
            return;
          }
          const remote = remoteRoot();
          const picker = remote && remote.directoryPicker;
          if (!picker || typeof picker.pick !== 'function') return;
          const picked = await picker.pick();
          if (typeof picked === 'string' && picked) patch({ target: picked });
        } catch {
          /* the picker is optional; the path field stays usable */
        }
      };

      const move = async () => {
        if (!canMove) return;
        const sessionId = state.sessionId;
        patch({ phase: 'moving', result: null, error: null });
        try {
          const settled = settle(await callRemote('move', sessionId, state.target.trim()));
          if (settled.error) {
            patch({ phase: 'error', error: settled.error });
          } else {
            patch({ phase: 'done', result: settled.value || settled.refusal });
            // The Host rewrote the stored header; ask the Client projection
            // service to rebuild this session's derived view.
            try {
              await optionalService(ctxRef, 'sessions')?.refreshProjections?.(sessionId);
            } catch {
              /* a stale projection is repaired by the next reload */
            }
          }
        } catch (error) {
          patch({ phase: 'error', error: describeError(error) });
        }
      };

      const close = () => patch({ open: false, phase: 'idle', result: null, error: null });

      // The store owns a held session's id, so the move can only finish after the
      // process that holds it is gone. The panel restarts the app; this does the
      // same from the dialog, because that is where the refusal is explained.
      const restartAndFinish = async () => {
        patch({ phase: 'moving' });
        try {
          await callRemote('restart', true);
        } catch (error) {
          patch({ phase: 'error', error: describeError(error) });
        }
      };

      const lines = [];

      lines.push(
        h(
          'div',
          { key: 'title', id: titleId, style: { fontSize: 15, fontWeight: 600, marginBottom: 14 } },
          t('title'),
        ),
      );

      lines.push(
        h(
          'div',
          { key: 'current', style: { marginBottom: 12 } },
          h('span', { style: labelStyle }, t('current')),
          h('div', { style: monoStyle }, state.info && state.info.cwd ? state.info.cwd : '—'),
        ),
      );

      if (state.phase === 'loading') {
        lines.push(h('div', { key: 'loading', style: { opacity: 0.7 } }, t('loading')));
      } else if (state.phase === 'blocked') {
        const detail = state.error || (state.info && state.info.message) || '';
        lines.push(
          h('div', { key: 'blocked', style: { color: DANGER_TEXT, marginBottom: 12 } }, codeText(state.info.code)),
        );
        if (detail) {
          lines.push(
            h(
              'div',
              { key: 'blocked-detail', style: { ...monoStyle, opacity: 0.65, marginBottom: 12 } },
              String(detail),
            ),
          );
        }
        lines.push(
          h(
            'div',
            { key: 'actions-blocked', style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
            h('button', { type: 'button', onClick: close, style: buttonStyle(false, false) }, t('close')),
          ),
        );
      } else if (state.result) {
        const value = state.result;
        const code = value.code;
        const outcome = outcomeOf(value);
        const ok = outcome === 'ok';
        const partial = outcome === 'partial';
        const accent = ok ? ACCENT_RGB : partial ? WARN_RGB : DANGER_RGB;
        lines.push(
          h(
            'div',
            {
              key: 'result',
              style: {
                marginBottom: 12,
                padding: '10px 12px',
                borderRadius: 8,
                background: `rgba(${accent},0.12)`,
                border: `1px solid rgba(${accent},0.4)`,
              },
            },
            h('div', { style: { fontWeight: 600, marginBottom: 4 } }, codeText(code)),
            value.newCwd ? h('div', { style: monoStyle }, value.newCwd) : null,
            value.message && !ok ? h('div', { style: { marginTop: 6, opacity: 0.8 } }, value.message) : null,
            value.needsRestart || partial
              ? h('div', { style: { marginTop: 6, opacity: 0.85 } }, t('restart'))
              : null,
            value.workspace && value.workspace.created
              ? h(
                  'div',
                  { style: { marginTop: 6, opacity: 0.8 } },
                  ZH ? '已创建工作区：' : 'Workspace created: ',
                  value.workspace.title,
                )
              : null,
          ),
        );
        lines.push(
          h(
            'div',
            { key: 'actions-result', style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
            h('button', { type: 'button', onClick: close, style: buttonStyle(false, false) }, t('close')),
            value.canRestart
              ? h(
                  'button',
                  { type: 'button', onClick: restartAndFinish, style: buttonStyle(true, false) },
                  t('restartAndMove'),
                )
              : ok
                ? h(
                    'button',
                    {
                      type: 'button',
                      onClick: () => window.location.reload(),
                      style: buttonStyle(true, false),
                    },
                    t('reload'),
                  )
                : null,
          ),
        );
      } else {
        lines.push(
          h(
            'div',
            { key: 'target', style: { marginBottom: 10 } },
            h('span', { style: labelStyle }, t('target')),
            h(
              'div',
              { style: { display: 'flex', gap: 8, alignItems: 'center' } },
              h('input', {
                value: state.target,
                onChange: onTarget,
                onKeyDown: (event) => {
                  if (event.key === 'Enter') move();
                  if (event.key === 'Escape') close();
                },
                placeholder: t('placeholder'),
                spellCheck: false,
                style: inputStyle,
                autoFocus: true,
              }),
              h('button', { type: 'button', onClick: browse, style: buttonStyle(false, false) }, t('browse')),
            ),
          ),
        );

        if (state.error) {
          lines.push(h('div', { key: 'error', style: { color: DANGER_TEXT, marginBottom: 10 } }, state.error));
        }

        lines.push(
          h('div', { key: 'hint', style: { opacity: 0.6, marginBottom: 14 } }, t('hint')),
        );
        lines.push(
          h(
            'div',
            { key: 'actions', style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
            h('button', { type: 'button', onClick: close, disabled: busy, style: buttonStyle(false, busy) }, t('cancel')),
            h(
              'button',
              { type: 'button', onClick: move, disabled: !canMove, style: buttonStyle(true, !canMove) },
              busy ? t('working') : t('confirm'),
            ),
          ),
        );
      }

      return h(
        'div',
        {
          style: scrimStyle,
          onMouseDown: (event) => {
            if (event.target === event.currentTarget && !busy) close();
          },
        },
        h(
          'div',
          { ref: cardRef, style: cardStyle, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
          ...lines,
        ),
      );
    }

    /* ------------------------------------------------------- workspace manager */

    /** Last path segment, tolerant of either separator and of a trailing one. */
    const baseName = (path) => {
      if (typeof path !== 'string') return '';
      const trimmed = path.replace(/[\\/]+$/, '');
      const at = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
      return at === -1 ? trimmed : trimmed.slice(at + 1);
    };

    async function pickDirectory() {
      try {
        const uiWorkspace = optionalService(ctxRef, 'uiWorkspace');
        if (uiWorkspace && typeof uiWorkspace.pickDirectory === 'function') {
          const picked = await uiWorkspace.pickDirectory();
          return typeof picked === 'string' && picked ? picked : null;
        }
        const remote = remoteRoot();
        const picker = remote && remote.directoryPicker;
        if (!picker || typeof picker.pick !== 'function') return null;
        const picked = await picker.pick();
        return typeof picked === 'string' && picked ? picked : null;
      } catch {
        return null;
      }
    }

    /** Shared outcome card: one code decides the accent, the rest is detail. */
    /**
     * Clear a finished result after a moment.
     *
     * A result that stays forever reads as a stuck dialog (the "workspace
     * deleted" banner never went away), so terminal results fade on their own.
     */
    function armDismiss(ms) {
      if (dismissTimer !== null) clearTimeout(dismissTimer);
      dismissTimer = setTimeout(() => {
        dismissTimer = null;
        patch({ result: null, phase: 'idle', error: null });
      }, ms);
    }

    function cancelDismiss() {
      if (dismissTimer !== null) {
        clearTimeout(dismissTimer);
        dismissTimer = null;
      }
    }

    function ResultCard(props) {
      const value = props.value || {};
      const code = typeof value.code === 'string' ? value.code : 'unknown';
      // One classifier for the whole UI: the card, the dialog banner and the
      // auto-dismiss rule never disagree about what a code means.
      const outcome = outcomeOf(value);
      const ok = outcome === 'ok';
      const accent = ok ? ACCENT_RGB : outcome === 'partial' ? WARN_RGB : DANGER_RGB;
      const lines = [];
      lines.push(h('div', { key: 'code', style: { fontWeight: 600, marginBottom: 4 } }, codeText(code)));
      if (value.newPath || value.newCwd) {
        lines.push(h('div', { key: 'path', style: monoStyle }, value.newPath || value.newCwd));
      }
      if (typeof value.moved === 'number') {
        lines.push(
          h('div', { key: 'moved', style: { marginTop: 4, opacity: 0.8 } }, `${value.moved} ${t('sessionCount')}`),
        );
      }
      if (Array.isArray(value.failed) && value.failed.length > 0) {
        lines.push(
          h(
            'div',
            { key: 'failed', style: { marginTop: 4, opacity: 0.85 } },
            value.failed
              .map((entry) => `${entry.sessionId}: ${codeText(entry.code) || entry.code}`)
              .join(' · '),
          ),
        );
      }
      if (value.message && !ok) {
        lines.push(h('div', { key: 'message', style: { marginTop: 6, opacity: 0.8 } }, value.message));
      }
      return h(
        'div',
        {
          key: 'result',
          style: {
            marginBottom: 12,
            padding: '10px 12px',
            borderRadius: 8,
            background: `rgba(${accent},0.12)`,
            border: `1px solid rgba(${accent},0.4)`,
          },
        },
        ...lines,
      );
    }


    /*
     * The panel borrows the harness card recipe (settings cards): a half-pixel
     * stroke, the xl radius and the settings fill, with the shared hover wash.
     * Every color comes from a `--dsw-*` alias so light and dark both work.
     */
    const PANEL_CSS = `
      .wsm-root{display:flex;flex-direction:column;gap:14px;padding:18px 20px 26px;color:var(--dsw-alias-label-primary,#ececf1);font-size:13px;line-height:1.55}
      .wsm-root :focus-visible{outline:2px solid var(--dsw-focus-ring-color,rgba(88,101,242,.65));outline-offset:2px}
      .wsm-headActions{display:flex;align-items:center;gap:8px}
      .wsm-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
      .wsm-headText{min-width:0}
      .wsm-title{margin:0;font-size:16px;font-weight:600;letter-spacing:.01em}
      .wsm-sub{margin:2px 0 0;font-size:12px;color:var(--dsw-alias-label-tertiary,rgba(236,236,241,.55))}
      .wsm-ghost{appearance:none;border:.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));background:transparent;color:var(--dsw-alias-label-secondary,rgba(236,236,241,.72));border-radius:var(--dsw-radius-md,8px);padding:4px 10px;font:inherit;font-size:12px;cursor:pointer;transition:background .16s,border-color .16s,color .16s}
      .wsm-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));border-color:var(--dsw-alias-border-l3,rgba(255,255,255,.26));color:var(--dsw-alias-label-primary,#ececf1)}
      .wsm-ghost:disabled{opacity:.45;cursor:default}
      .wsm-primary{appearance:none;border:0;border-radius:var(--dsw-radius-md,8px);padding:5px 14px;font:inherit;font-size:12px;font-weight:500;cursor:pointer;background:var(--dsw-alias-button-primary-fill,#5865f2);color:var(--dsw-alias-label-primary-inverted,#fff);transition:background .16s,opacity .16s}
      .wsm-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#4a56d8)}
      .wsm-primary:disabled{opacity:.45;cursor:default}
      .wsm-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(262px,1fr));gap:12px;margin:0;padding:0;list-style:none}
      .wsm-card{display:flex;flex-direction:column;gap:9px;padding:14px;border:.5px solid var(--dsw-alias-settings-card-stroke,rgba(255,255,255,.12));border-radius:var(--dsw-radius-xl,14px);background:var(--dsw-alias-settings-card-fill,rgba(255,255,255,.035));transition:border-color .16s,background .16s}
      .wsm-card:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));border-color:var(--dsw-alias-border-l3,rgba(255,255,255,.22))}
      .wsm-cardTop{display:flex;align-items:center;gap:8px;min-width:0}
      .wsm-dot{width:7px;height:7px;border-radius:50%;flex:none;box-shadow:0 0 0 3px color-mix(in srgb,currentColor 16%,transparent);background:currentColor}
      .wsm-dot-idle{color:var(--dsw-alias-state-success-primary,#4bbf83)}
      .wsm-dot-running{color:var(--dsw-alias-state-warn-primary,#e0a044)}
      .wsm-dot-missing{color:var(--dsw-alias-state-error-primary,#e06a6a)}
      .wsm-name{font-size:14px;font-weight:500;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .wsm-path{font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,monospace);font-size:11.5px;line-height:1.45;color:var(--dsw-alias-label-tertiary,rgba(236,236,241,.5));overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .wsm-path-wrap{white-space:normal;word-break:break-all}
      .wsm-badges{display:flex;flex-wrap:wrap;gap:6px}
      .wsm-badge{display:inline-flex;align-items:center;gap:4px;padding:0 7px;border-radius:var(--dsw-radius-xs,6px);border:.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));font-size:11px;line-height:18px;white-space:nowrap;color:var(--dsw-alias-label-secondary,rgba(236,236,241,.72))}
      .wsm-badge-warn{color:var(--dsw-alias-state-warn-label,#e0b060);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#e0a044) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#e0a044) 12%,transparent)}
      .wsm-badge-info{color:var(--dsw-alias-label-primary-bluish,#9db4f0);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#5865f2) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#5865f2) 10%,transparent)}
      .wsm-badge-danger{color:var(--dsw-alias-label-error,#e06a6a);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e06a6a) 50%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e06a6a) 12%,transparent)}
      .wsm-note{margin:0;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary,rgba(236,236,241,.55))}
      .wsm-note-warn{color:var(--dsw-alias-state-warn-label,#e0b060)}
      .wsm-foot{display:flex;flex-wrap:wrap;gap:6px;margin-top:auto;padding-top:9px;border-top:.5px solid var(--dsw-alias-separator-primary,rgba(255,255,255,.08))}
      .wsm-action{appearance:none;border:.5px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,rgba(236,236,241,.72));border-radius:var(--dsw-radius-sm,6px);padding:2px 8px;font:inherit;font-size:12px;cursor:pointer;transition:background .16s,color .16s,border-color .16s}
      .wsm-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));border-color:var(--dsw-alias-border-l2,rgba(255,255,255,.16));color:var(--dsw-alias-label-primary,#ececf1)}
      .wsm-action-danger:hover:not(:disabled){color:var(--dsw-alias-label-error,#e06a6a);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e06a6a) 45%,transparent);background:var(--dsw-alias-interactive-bg-hover-danger,rgba(224,106,106,.12))}
      .wsm-action:disabled{opacity:.4;cursor:default}
      .wsm-empty{display:flex;flex-direction:column;align-items:center;gap:6px;grid-column:1/-1;padding:34px 16px;text-align:center;border:.5px dashed var(--dsw-alias-border-l2,rgba(255,255,255,.16));border-radius:var(--dsw-radius-xl,14px);color:var(--dsw-alias-label-tertiary,rgba(236,236,241,.55))}
      .wsm-emptyTitle{font-size:13px;font-weight:500;color:var(--dsw-alias-label-secondary,rgba(236,236,241,.72))}
      .wsm-skeleton{height:132px;border-radius:var(--dsw-radius-xl,14px);background:var(--dsw-alias-bg-skeleton,rgba(255,255,255,.05));animation:wsm-pulse 1.5s ease-in-out infinite}
      @keyframes wsm-pulse{0%,100%{opacity:.55}50%{opacity:.9}}
      @media (prefers-reduced-motion:reduce){.wsm-skeleton{animation:none}.wsm-card,.wsm-ghost,.wsm-action,.wsm-primary,.wsm-source{transition:none}}
      .wsm-modal{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.42);backdrop-filter:blur(1.5px)}
      .wsm-modalCard{width:100%;max-width:560px;max-height:86vh;overflow:auto;display:flex;flex-direction:column;border-radius:calc(var(--dsw-radius-xl,14px) + 2px);background:var(--dsw-alias-bg-l1,#1c1c1f);box-shadow:0 24px 64px rgba(0,0,0,.45)}
      .wsm-modalCard .wsm-detail{max-width:none;border:none;border-radius:0;background:transparent}
      .wsm-modal .wsm-detail{max-width:560px}
      .wsm-detail{display:flex;flex-direction:column;gap:13px;padding:16px;max-width:560px;border:.5px solid var(--dsw-alias-settings-card-stroke,rgba(255,255,255,.12));border-radius:var(--dsw-radius-xl,14px);background:var(--dsw-alias-settings-card-fill,rgba(255,255,255,.035))}
      .wsm-detailHead{display:flex;align-items:baseline;gap:8px;min-width:0}
      .wsm-detailName{font-size:14px;font-weight:500;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .wsm-section{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,rgba(236,236,241,.55))}
      .wsm-field{display:flex;flex-direction:column;gap:6px}
      .wsm-label{font-size:12px;color:var(--dsw-alias-label-tertiary,rgba(236,236,241,.55))}
      .wsm-inline{display:flex;gap:8px;align-items:center}
      .wsm-input{flex:1;min-width:0;padding:6px 9px;font:inherit;font-size:12.5px;color:var(--dsw-alias-label-primary,#ececf1);background:var(--dsw-alias-bg-l2,rgba(255,255,255,.05));border:.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));border-radius:var(--dsw-radius-md,8px)}
      .wsm-input:focus-visible{border-color:var(--dsw-alias-state-business-primary,#5865f2)}
      .wsm-sources{display:flex;flex-direction:column;gap:6px;max-height:300px;overflow-y:auto}
      .wsm-source{display:flex;align-items:center;gap:9px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:var(--dsw-radius-lg,10px);cursor:pointer;transition:background .16s,border-color .16s}
      .wsm-source:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
      .wsm-source[data-picked=true]{border-color:var(--dsw-alias-brand-primary,#5865f2);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#5865f2) 10%,transparent)}
      .wsm-source[data-blocked=true]{cursor:default;opacity:.65}
      .wsm-sourceName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
      .wsm-actions{display:flex;justify-content:flex-end;gap:8px;padding-top:2px}
      .wsm-check{display:flex;align-items:flex-start;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary,rgba(236,236,241,.72));cursor:pointer}
      .wsm-check input{margin-top:2px}
      .wsm-error{color:var(--dsw-alias-label-error,#e06a6a);font-size:12px}
    `;

    /* ------------------------------------------------------ workspace panel */

    /** `n` sessions, or an em dash when the count could not be read. */
    function countText(value) {
      if (value === null || value === undefined) return '—';
      return `${value} ${t('sessionCount')}`;
    }

    const NOOP_HOOK = (selector) => (typeof selector === 'function' ? selector(null) : null);

    /**
     * Read the same two sources the shipped sidebar reads.
     *
     * The sidebar decides whether a session runs with
     * `useSessionStatus().get(id)?.running ?? useSessions().byId[id]?.running`,
     * so the panel uses that exact chain. `null` means "this build did not tell
     * us", and only then does the panel fall back to the host summary.
     */
    function liveRunReader(props) {
      const statusHook = props && typeof props.useSessionStatus === 'function' ? props.useSessionStatus : NOOP_HOOK;
      const sessionsHook = props && typeof props.useSessions === 'function' ? props.useSessions : NOOP_HOOK;
      const statuses = statusHook((value) => value);
      const byId = sessionsHook((state) => state && state.byId);
      return (sessionId) => {
        const key = String(sessionId);
        const live = statuses && typeof statuses.get === 'function' ? statuses.get(key) : undefined;
        if (live && typeof live.running === 'boolean') return live.running;
        const row = byId ? byId[key] : undefined;
        if (row && typeof row.running === 'boolean') return row.running;
        return null;
      };
    }

    /**
     * Re-derive one workspace row from live session state.
     *
     * `blocked` now means "a session is mid-turn". A session the app merely has
     * open is `open`, not `blocked`: the host releases it before touching files,
     * so it must not grey out the buttons.
     */
    function reconcileEntry(entry, liveRunning) {
      const names = Array.isArray(entry.blockers) ? entry.blockers : [];
      const blockers = names.map((name) => {
        const live = liveRunning(name.id);
        const running = live === null ? name.running === true : live;
        return { ...name, running, open: !running };
      });
      // Sessions past the host's cap have no row to consult; the host counts
      // stand in for them so the chip cannot under-report.
      const capped = typeof entry.blockedTotal === 'number' && entry.blockedTotal > names.length;
      const running = Math.max(blockers.filter((name) => name.running).length, capped ? entry.running || 0 : 0);
      const open = Math.max(blockers.filter((name) => !name.running).length, capped ? entry.open || 0 : 0);
      return { ...entry, blockers, running, open, blocked: running > 0 };
    }

    /**
     * The workspace manager, rendered as its own central panel.
     *
     * Occupancy is reported per workspace by the host *before* anything is
     * clicked: a workspace whose sessions are held by the app (or mid-turn)
     * shows how many and which ones, and its rebuild/merge/remove buttons stay
     * off, so the refusal never arrives as a surprise after the fact.
     */
    /** One action in a card footer or a dialog footer. */
    function makeAction(t) {
      return (key, onClick, disabled, danger) =>
        h(
          'button',
          {
            type: 'button',
            className: `wsm-action${danger ? ' wsm-action-danger' : ''}`,
            onClick,
            disabled,
          },
          t(key),
        );
    }

    /** One workspace card: name, path, live activity and the four actions. */
    function workspaceCard(entry, handlers) {
      const action = makeAction(handlers.t);
      const blocked = entry.blocked === true;
      const names = Array.isArray(entry.blockers) ? entry.blockers : [];
      const runningNames = names.filter((name) => name.running).map((name) => name.title || name.id);
      const openNames = names.filter((name) => !name.running).map((name) => name.title || name.id);
      const tone = entry.exists === false ? 'missing' : blocked ? 'running' : 'idle';
      const badges = [h('span', { key: 'sessions', className: 'wsm-badge' }, countText(entry.sessions))];
      if (entry.exists === false) {
        badges.push(h('span', { key: 'missing', className: 'wsm-badge wsm-badge-danger' }, handlers.t('missingDir')));
      }
      if (entry.running > 0) {
        badges.push(
          h(
            'span',
            { key: 'running', className: 'wsm-badge wsm-badge-warn', title: runningNames.join(' · ') },
            handlers.t('runningChip').replace('{n}', String(entry.running)),
          ),
        );
      } else if (entry.open > 0) {
        badges.push(
          h(
            'span',
            { key: 'open', className: 'wsm-badge wsm-badge-info', title: openNames.join(' · ') },
            handlers.t('openChip').replace('{n}', String(entry.open)),
          ),
        );
      }
      return h(
        'article',
        { key: entry.id, className: 'wsm-card', 'data-blocked': blocked ? 'true' : 'false' },
        h(
          'div',
          { className: 'wsm-cardTop' },
          h('span', { className: `wsm-dot wsm-dot-${tone}`, 'aria-hidden': true }),
          h('span', { className: 'wsm-name', title: entry.title }, entry.title),
        ),
        h('div', { className: 'wsm-path', title: entry.path }, entry.path),
        h('div', { className: 'wsm-badges' }, ...badges),
        blocked
          ? h('p', { className: 'wsm-note wsm-note-warn' }, handlers.t('busyHint'))
          : entry.open > 0
            ? h('p', { className: 'wsm-note' }, handlers.t('openHint'))
            : null,
        h(
          'div',
          { className: 'wsm-foot' },
          action('rebuild', handlers.onRebuild, handlers.busy || blocked),
          action('merge', handlers.onMerge, handlers.busy || blocked),
          action('rename', handlers.onRename, handlers.busy || blocked),
          action('remove', handlers.onRemove, handlers.busy || blocked, true),
        ),
      );
    }

    function WorkspacePanel(props) {
      const state = useStore();
      const busy = state.phase === 'moving';
      const live = liveRunReader(props);
      const list = Array.isArray(state.workspaces)
        ? state.workspaces.map((entry) => reconcileEntry(entry, live))
        : null;
      const view = state.panelView || 'list';
      // A capability that is missing means this build changed underneath the
      // plugin; say so instead of silently skipping the repair steps.
      const internals = state.internals;
      const current = list === null ? null : list.find((entry) => entry.id === state.workspaceId) || null;
      const loaded = React.useRef(false);

      React.useEffect(() => {
        if (loaded.current) return;
        loaded.current = true;
        if (!Array.isArray(store.workspaces)) loadWorkspaces();
      }, []);

      const toList = () => patch({ panelView: 'list', result: null, error: null, workspaceId: null });
      const action = makeAction(t);

      const totals = (list || []).reduce(
        (acc, entry) => ({
          sessions: acc.sessions + (entry.sessions || 0),
          running: acc.running + (entry.running || 0),
        }),
        { sessions: 0, running: 0 },
      );

      const subtitle =
        view === 'list'
          ? `${t('workspacesLabel').replace('{n}', String(list ? list.length : 0))} · ${totals.sessions} ${t('sessionCount')}`
          : t(`${view}Title`);

      const head = h(
        'header',
        { className: 'wsm-head', key: 'head' },
        h(
          'div',
          { className: 'wsm-headText' },
          h('h2', { className: 'wsm-title' }, t('panelTitle')),
          h('p', { className: 'wsm-sub' }, subtitle),
        ),
        view === 'list'
          ? h(
              'div',
              { className: 'wsm-headActions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'wsm-ghost',
                  onClick: () => patch({ panelView: 'restart', result: null, error: null }),
                  disabled: busy || (state.restartInfo !== null && state.restartInfo.supported === false),
                  title: state.restartInfo?.supported === false ? t('restartUnsupported') : undefined,
                },
                t('restartButton'),
              ),
              h(
                'button',
                { type: 'button', className: 'wsm-ghost', onClick: () => loadWorkspaces(), disabled: busy },
                t('refreshList'),
              ),
            )
          : h('button', { type: 'button', className: 'wsm-ghost', onClick: toList, disabled: busy }, `← ${t('back')}`),
      );

      const notes = [];
      if (state.error) notes.push(h('p', { className: 'wsm-error', key: 'error' }, state.error));
      if (state.result) notes.push(h(ResultCard, { key: 'result', value: state.result }));
      if (internals && (internals.registryIndex === false || internals.agentRelease === false)) {
        notes.push(h('p', { className: 'wsm-note wsm-note-warn', key: 'degraded' }, t('degraded')));
      }

      let detail = null;

      // The list stays mounted behind every task: switching tasks opens a
      // confirmation dialog over it, so cancelling returns to the same view.
      const listBody = (() => {

        if (list === null) {
          return h(
            'div',
            { className: 'wsm-grid', key: 'loading' },
            ...[0, 1, 2].map((index) => h('div', { className: 'wsm-skeleton', key: index, 'aria-hidden': true })),
          );
        } else if (list.length === 0) {
          return h(
            'div',
            { className: 'wsm-grid', key: 'empty' },
            h(
              'div',
              { className: 'wsm-empty' },
              h('span', { className: 'wsm-emptyTitle' }, t('noWorkspaces')),
              h('span', {}, t('panelHint')),
            ),
          );
        } else {
          return h(
            'div',
            { className: 'wsm-grid', key: 'rows' },
            ...list.map((entry) =>
              workspaceCard(entry, {
                t,
                busy,
                onRebuild: () =>
                  patch({ panelView: 'rebuild', workspaceId: entry.id, target: '', result: null, error: null }),
                onMerge: () => patch({ panelView: 'merge', workspaceId: entry.id, picks: [], result: null, error: null }),
                onRename: () =>
                  patch({ panelView: 'rename', workspaceId: entry.id, titleText: entry.title, result: null, error: null }),
                onRemove: () => patch({ panelView: 'remove', workspaceId: entry.id, result: null, error: null }),
              }),
            ),
          );
        }
      })();

      if (view === 'restart') {
        const running = Array.isArray(state.restartInfo?.running) ? state.restartInfo.running : [];
        detail = h(
          'section',
          { className: 'wsm-detail', key: 'detail' },
          h(
            'div',
            { className: 'wsm-detailHead' },
            h('span', { className: 'wsm-section' }, t('restartTitle')),
          ),
          h('p', { className: 'wsm-note' }, t('restartHint')),
          running.length > 0
            ? h(
                'p',
                { className: 'wsm-note wsm-note-warn' },
                t('restartRunning').replace('{n}', String(running.length)),
              )
            : null,
          state.restartInfo && state.restartInfo.supported === false
            ? h('p', { className: 'wsm-error' }, t('restartUnsupported'))
            : null,
          h(
            'div',
            { className: 'wsm-actions' },
            h('button', { type: 'button', className: 'wsm-ghost', onClick: toList, disabled: busy }, t('cancel')),
            h(
              'button',
              {
                type: 'button',
                className: 'wsm-primary',
                onClick: runRestart,
                disabled: busy || (state.restartInfo !== null && state.restartInfo.supported === false),
              },
              busy ? t('restarting') : t('doRestart'),
            ),
          ),
        );
      } else if (view === 'rebuild') {
        const blocked = current ? current.blocked === true : false;
        detail = h(
          'section',
          { className: 'wsm-detail', key: 'detail' },
          h(
            'div',
            { className: 'wsm-detailHead' },
            h('span', { className: 'wsm-section' }, t('rebuildTitle')),
            h('span', { className: 'wsm-detailName', title: current ? current.title : '' }, current ? current.title : '—'),
          ),
          h(
            'div',
            { className: 'wsm-field' },
            h('span', { className: 'wsm-label' }, t('current')),
            h('div', { className: 'wsm-path wsm-path-wrap' }, current ? current.path : '—'),
          ),
          blocked ? h('p', { className: 'wsm-note wsm-note-warn' }, t('busyHint')) : null,
          h(
            'div',
            { className: 'wsm-field' },
            h('span', { className: 'wsm-label' }, t('newDir')),
            h(
              'div',
              { className: 'wsm-inline' },
              h('input', {
                className: 'wsm-input',
                value: state.target,
                onChange: (event) => patch({ target: event.target.value }),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') runRebuild();
                  if (event.key === 'Escape') toList();
                },
                placeholder: t('placeholder'),
                spellCheck: false,
                autoFocus: true,
              }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'wsm-ghost',
                  disabled: busy,
                  onClick: async () => {
                    const picked = await pickDirectory();
                    if (picked) patch({ target: picked });
                  },
                },
                t('browse'),
              ),
            ),
          ),
          h(
            'div',
            { className: 'wsm-actions' },
            h('button', { type: 'button', className: 'wsm-ghost', onClick: toList, disabled: busy }, t('cancel')),
            h(
              'button',
              {
                type: 'button',
                className: 'wsm-primary',
                onClick: runRebuild,
                disabled: busy || blocked || state.target.trim() === '',
              },
              busy ? t('rebuilding') : t('doRebuild'),
            ),
          ),
        );
      } else if (view === 'merge') {
        const others = (list || []).filter((entry) => entry.id !== state.workspaceId);
        detail = h(
          'section',
          { className: 'wsm-detail', key: 'detail' },
          h(
            'div',
            { className: 'wsm-detailHead' },
            h('span', { className: 'wsm-section' }, t('mergeTitle')),
            h('span', { className: 'wsm-detailName', title: current ? current.title : '' }, current ? current.title : '—'),
          ),
          h(
            'div',
            { className: 'wsm-field' },
            h('span', { className: 'wsm-label' }, t('pickSources')),
            others.length === 0
              ? h('p', { className: 'wsm-note' }, t('noOtherWorkspace'))
              : h(
                  'div',
                  { className: 'wsm-sources' },
                  ...others.map((entry) => {
                    const picked = state.picks.includes(entry.id);
                    const blocked = entry.blocked === true;
                    return h(
                      'label',
                      {
                        key: entry.id,
                        className: 'wsm-source',
                        'data-picked': picked ? 'true' : 'false',
                        'data-blocked': blocked ? 'true' : 'false',
                        title: entry.path,
                      },
                      h('input', {
                        type: 'checkbox',
                        checked: picked,
                        disabled: busy || blocked,
                        onChange: () =>
                          patch({
                            picks: picked ? state.picks.filter((id) => id !== entry.id) : [...state.picks, entry.id],
                          }),
                      }),
                      h('span', { className: 'wsm-sourceName' }, entry.title),
                      h('span', { className: 'wsm-badge' }, countText(entry.sessions)),
                      blocked
                        ? h(
                            'span',
                            { className: 'wsm-badge wsm-badge-warn' },
                            t('runningChip').replace('{n}', String(entry.running || 0)),
                          )
                        : null,
                    );
                  }),
                ),
          ),
          h(
            'div',
            { className: 'wsm-actions' },
            h('button', { type: 'button', className: 'wsm-ghost', onClick: toList, disabled: busy }, t('cancel')),
            h(
              'button',
              {
                type: 'button',
                className: 'wsm-primary',
                onClick: runMerge,
                disabled: busy || state.picks.length === 0,
              },
              busy ? t('merging') : t('doMerge'),
            ),
          ),
        );
      } else if (view === 'rename') {
        detail = h(
          'section',
          { className: 'wsm-detail', key: 'detail' },
          h(
            'div',
            { className: 'wsm-detailHead' },
            h('span', { className: 'wsm-section' }, t('renameTitle')),
            h('span', { className: 'wsm-detailName', title: current ? current.path : '' }, current ? current.path : '—'),
          ),
          h(
            'div',
            { className: 'wsm-field' },
            h('span', { className: 'wsm-label' }, t('renameLabel')),
            h('input', {
              className: 'wsm-input',
              value: state.titleText || '',
              onChange: (event) => patch({ titleText: event.target.value }),
              onKeyDown: (event) => {
                if (event.key === 'Enter') runRename();
                if (event.key === 'Escape') toList();
              },
              placeholder: t('needTitle'),
              spellCheck: false,
              autoFocus: true,
            }),
          ),
          h(
            'div',
            { className: 'wsm-actions' },
            h('button', { type: 'button', className: 'wsm-ghost', onClick: toList, disabled: busy }, t('cancel')),
            h(
              'button',
              { type: 'button', className: 'wsm-primary', onClick: runRename, disabled: busy },
              busy ? t('renaming') : t('doRename'),
            ),
          ),
        );
      } else if (view === 'remove') {
        detail = h(
          'section',
          { className: 'wsm-detail', key: 'detail' },
          h(
            'div',
            { className: 'wsm-detailHead' },
            h('span', { className: 'wsm-section' }, t('removeTitle')),
            h('span', { className: 'wsm-detailName', title: current ? current.title : '' }, current ? current.title : '—'),
          ),
          h('p', { className: 'wsm-note' }, t('removeHint')),
          h(
            'label',
            { className: 'wsm-check' },
            h('input', {
              type: 'checkbox',
              checked: Boolean(state.keepSessions),
              onChange: () => patch({ keepSessions: !state.keepSessions }),
            }),
            h('span', {}, t('keepSessions')),
          ),
          h(
            'div',
            { className: 'wsm-actions' },
            h('button', { type: 'button', className: 'wsm-ghost', onClick: toList, disabled: busy }, t('cancel')),
            h(
              'button',
              {
                type: 'button',
                className: 'wsm-primary',
                onClick: runRemove,
                disabled: busy,
                style: { background: 'var(--dsw-alias-state-error-primary,#d9534f)' },
              },
              busy ? t('removing') : t('doRemove'),
            ),
          ),
        );
      } else {
        body = null;
      }

      const modal = detail
        ? h(
            'div',
            { className: 'wsm-modal', key: 'modal', onClick: toList },
            h(
              'div',
              {
                className: 'wsm-modalCard',
                role: 'dialog',
                'aria-modal': 'true',
                'aria-label': t(`${view}Title`),
                onClick: (event) => event.stopPropagation(),
                onKeyDown: (event) => {
                  if (event.key === 'Escape') toList();
                },
              },
              detail,
            ),
          )
        : null;

      return h('div', { className: 'wsm-root' }, head, ...notes, listBody, modal);
    }

    function PanelIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 18;
      const active = Boolean(props && props.active);
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block', opacity: active ? 1 : 0.78 },
        },
        h('rect', { x: 3, y: 4, width: 7, height: 7, rx: 1.5, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('rect', { x: 14, y: 4, width: 7, height: 7, rx: 1.5, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('rect', { x: 3, y: 14, width: 7, height: 7, rx: 1.5, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', {
          d: 'M14 17.5h7M17.5 14v7',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
      );
    }

    /**
     * The same manager, reachable from Settings.
     *
     * `settings.section` renders inside the settings panel, whose owner hands a
     * section only `close()`. The panel itself is dispatched through the layout
     * service, so this entry is a launcher with the occupancy summary in front
     * of it rather than a second copy of the manager.
     */
    function SettingsEntry(props) {
      const state = useStore();
      const close = props && typeof props.close === 'function' ? props.close : null;
      React.useEffect(() => {
        if (!Array.isArray(store.workspaces)) loadWorkspaces().catch(() => {});
      }, []);
      const list = Array.isArray(state.workspaces) ? state.workspaces : null;
      const count =
        list === null ? '' : String(pick(TEXT.settingsCount) || '').replace('{n}', String(list.length));
      const open = () => {
        const layout = optionalService(ctxRef, 'layout');
        try {
          if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(PANEL_KEY);
        } catch (error) {
          console.error('[dsh-workspace-control] selectPanel failed', error);
        }
        if (close) close();
      };
      return h(
        'div',
        { style: { display: 'grid', gap: 10, maxWidth: 560 } },
        h('div', { key: 'title', style: { fontSize: 16, fontWeight: 600 } }, t('settingsTitle')),
        h('div', { key: 'hint', style: { fontSize: 13, lineHeight: 1.55, opacity: 0.75 } }, t('settingsHint')),
        count
          ? h('div', { key: 'count', style: { fontSize: 12, opacity: 0.6 } }, count)
          : null,
        h(
          'button',
          {
            key: 'open',
            type: 'button',
            onClick: open,
            style: {
              justifySelf: 'start',
              padding: '7px 14px',
              borderRadius: 8,
              border: '1px solid rgba(255,255,255,0.18)',
              background: 'rgba(255,255,255,0.06)',
              color: 'inherit',
              font: 'inherit',
              fontSize: 13,
              cursor: 'pointer',
            },
          },
          t('openPanel'),
        ),
      );
    }

    /** One overlay occupant, kept for the session-level move dialog. */
    function Shell() {
      const state = useStore();
      if (!state.open || state.mode !== 'session') return null;
      return h(Dialog);
    }

    /* ------------------------------------------------------------------ flow */

    /**
     * Open the session dialog.
     *
     * @param hint - live running state from the Client (`null` when unknown).
     *   When the client says the session is idle, the host's own verdict is still
     *   forwarded, but it no longer blocks ahead of the click.
     */
    async function openDialog(sessionId, displayTitle, hint) {
      patch({
        open: true,
        mode: 'session',
        sessionId,
        displayTitle: displayTitle || '',
        phase: 'loading',
        info: null,
        target: '',
        result: null,
        error: null,
      });
      try {
        const settled = settle(await callRemote('inspect', sessionId));
        if (settled.error) {
          patch({ phase: 'blocked', info: { code: 'unreadable' }, error: settled.error });
          return;
        }
        const info = settled.value || settled.refusal || {};
        if (info.status !== 'ok') {
          patch({ phase: 'blocked', info: { ...info, code: info.code || 'unknown' } });
          return;
        }
        if (info.running && hint !== false) {
          patch({ phase: 'blocked', info: { ...info, code: 'running' } });
          return;
        }
        if (!info.cwd) {
          patch({ phase: 'blocked', info: { ...info, code: 'no-cwd' } });
          return;
        }
        patch({ phase: 'ready', info });
      } catch (error) {
        patch({ phase: 'blocked', info: { code: 'unreadable' }, error: error && error.message });
      }
    }

    /* ------------------------------------------------------- manager flow */

    /** Read the workspace list; the counts come from the stored headers. */
    async function loadWorkspaces() {
      try {
        const settled = settle(await callRemote('listWorkspaces'));
        if (settled.error) throw new Error(settled.error);
        const value = settled.value || {};
        if (value.status !== 'ok') throw new Error(codeText(value.code) || value.code || 'error');
        patch({
          workspaces: Array.isArray(value.workspaces) ? value.workspaces : [],
          internals: value.internals && typeof value.internals === 'object' ? value.internals : null,
          phase: store.result ? 'done' : 'ready',
          error: null,
        });
      } catch (error) {
        patch({ workspaces: [], phase: 'error', error: describeError(error) });
      }
      try {
        const probe = settle(await callRemote('probeRestart'));
        if (probe.value) patch({ restartInfo: probe.value });
      } catch {
        // A build without the capability is not an error worth showing.
      }
    }

    /** Restart the desktop app, so a held session lets go without a tray click. */
    async function runRestart() {
      const running = Array.isArray(store.restartInfo?.running) ? store.restartInfo.running : [];
      patch({ phase: 'moving', result: null, error: null });
      try {
        const settled = settle(await callRemote('restart', running.length > 0));
        if (settled.error) {
          patch({ phase: 'error', error: settled.error });
          return;
        }
        patch({ phase: 'done', result: settled.refusal || settled.value });
      } catch (error) {
        patch({ phase: 'error', error: describeError(error) });
      }
    }

    /**
     * Run one manager action and fold its outcome into the store.
     *
     * Every view ends the same way, so the rule lives here once: a transport
     * failure becomes `phase: 'error'`; a Host result (success or refusal) goes
     * to `phase: 'done'` where the result card explains it; the workspace list
     * is refreshed either way once the call settled.
     */
    async function runAction(method, args, changes = {}) {
      patch({ phase: 'moving', result: null, error: null });
      try {
        const settled = settle(await callRemote(method, ...args));
        if (settled.error) {
          patch({ phase: 'error', error: settled.error });
          return null;
        }
        patch({ phase: 'done', result: settled.value ?? settled.refusal ?? null, ...changes });
        await loadWorkspaces();
        return settled;
      } catch (error) {
        patch({ phase: 'error', error: describeError(error) });
        return null;
      }
    }

    /**
     * Set a workspace title to the name of its own directory.
     *
     * Only reachable when the manager found a stored title that no longer
     * matches its folder, so it never fires on a title the user chose.
     */
    async function runRetitle(workspaceId, title) {
      if (!workspaceId || !title) return;
      await runAction('retitleWorkspace', [workspaceId, title], { panelView: 'list' });
    }

    async function runRebuild() {
      const workspaceId = store.workspaceId;
      const target = store.target.trim();
      if (!workspaceId) return;
      if (!target) {
        patch({ error: t('needTarget') });
        return;
      }
      await runAction('rebuildWorkspace', [workspaceId, target], { panelView: 'list' });
    }

    async function runMerge() {
      const workspaceId = store.workspaceId;
      const sourceIds = store.picks.slice();
      if (!workspaceId) return;
      if (sourceIds.length === 0) {
        patch({ error: t('needSource') });
        return;
      }
      await runAction('mergeWorkspaces', [workspaceId, sourceIds], { panelView: 'list' });
    }

    /** Rename a workspace from the panel. */
    async function runRename() {
      const workspaceId = store.workspaceId;
      const title = String(store.titleText || '').trim();
      if (!workspaceId) return;
      if (title === '') {
        patch({ error: t('needTitle') });
        return;
      }
      await runAction('retitleWorkspace', [workspaceId, title], { panelView: 'list', workspaceId: null });
    }

    /**
     * Remove one workspace record.
     *
     * `keepSessions` decides whether its sessions stay in the list (archived or
     * not); the panel exposes it, because "delete the group" and "delete the
     * sessions too" are different intentions.
     */
    async function runRemove() {
      const workspaceId = store.workspaceId;
      if (!workspaceId) return;
      await runAction('removeWorkspace', [workspaceId, Boolean(store.keepSessions)], {
        panelView: 'list',
        workspaceId: null,
      });
    }

    /* ------------------------------------------------------------------ entry */

    return {
      // `remote` is the Cordis service key of the Client Remote (the gateway's
      // browser face). Without it in `inject`, reading `ctx.remote` throws
      // "cannot get property \"remote\" without inject".
      inject: ['slots', 'locale', 'remote'],
      // Pure functions the tests drive directly: the status chain is the part
      // that must agree with the sidebar, and rendering it would need a DOM.
      testables: { liveRunReader, reconcileEntry },
      apply(ctx) {
        ctxRef = ctx;

        const style = document.createElement('style');
        style.textContent =
          PANEL_CSS + '.wsm-dialog input:focus-visible{outline:2px solid rgba(88,101,242,0.6);outline-offset:1px}';
        const attach = () => document.head.appendChild(style);
        if (document.head) attach();
        else document.addEventListener('DOMContentLoaded', attach, { once: true });

        ctx.effect(() => () => {
          style.remove();
          ctxRef = null;
          mountPromise = null;
          mountFailure = null;
          mountSucceeded = false;
          mountValue = undefined;
          scopedCtx = null;
          patch({ open: false, phase: 'idle', result: null, error: null });
          listeners.clear();
        });

        // Mount eagerly when the gateway is already there; otherwise the first
        // menu interaction mounts it.
        armScopedInject(ctx);
        ensureNamespace().catch(() => {
          /* the row stays visible; opening it reports the failure */
        });

        // Dictionaries go in through the per-locale form: the namespace is not
        // part of the compile-time merge table, and one locale failing here must
        // never take the whole Client half down.
        if (ctx.locale && typeof ctx.locale.register === 'function') {
          ctx.effect(() => {
            const disposers = [];
            for (const language of ['en', 'zh']) {
              try {
                disposers.push(ctx.locale.register(NS, language, flatten(language)));
              } catch (error) {
                console.error('[dsh-workspace-control] locale registration failed', language, error);
              }
            }
            return () => {
              for (const dispose of disposers) {
                try {
                  dispose();
                } catch {
                  /* the whole plugin is going away anyway */
                }
              }
            };
          }, 'dsh-workspace-control: dictionaries');
        }

        ctx.slots.inject(SLOT, () =>
          ctx.slots.register(
            { name: SLOT, id: 'workspace-control-move', order: 500, locale: NS },
            MenuRow,
          ),
        );

        ctx.slots.inject(OVERLAY, () =>
          ctx.slots.register(
            { name: OVERLAY, id: 'workspace-control-dialog', order: 40, locale: NS },
            Shell,
          ),
        );

        // The workspace row's own "..." menu has no extension slot (the whole
        // browser region is a single `shadows-shipped-ui` hole), so workspace
        // management gets its own central panel: a sidebar entry plus the panel
        // the entry dispatches, both keyed by the same id.
        ctx.slots.inject(MAIN, () =>
          ctx.slots.register({ name: MAIN, key: PANEL_KEY, locale: NS }, WorkspacePanel),
        );

        // Settings is the third door to the same panel, so the feature is
        // discoverable from where users look for configuration.
        ctx.slots.inject(SETTINGS, () =>
          ctx.slots.register(
            { name: SETTINGS, id: 'workspace-control-settings', order: 25, locale: NS, label: () => t('panelTitle') },
            SettingsEntry,
          ),
        );

        // The sidebar owns this button and addresses the main panel by list id.
        ctx.slots.inject(PANEL, () =>
          ctx.slots.register(
            { name: PANEL, id: PANEL_KEY, order: 20, locale: NS, label: () => t('panelTitle') },
            PanelIcon,
          ),
        );
      },
    };
}

window.__ModuleLoader__.load({
  id: 'dsh-workspace-control',
  factory(require) {
    try {
      return build(require);
    } catch (error) {
      // A throw in this factory aborts the whole Web boot ("1 entry did not
      // activate") and leaves the user with an application that will not
      // start, so this half degrades to "absent" instead.
      console.error('[dsh-workspace-control] failed to build the client half', error);
      return { inject: [], apply() {} };
    }
  },
});
