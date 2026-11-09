/*
 * This file is served as a classic script and the page can evaluate it twice in
 * one document (its own startup script plus the composed batch). At top level
 * that would redeclare every `const` below, which is a parse-time SyntaxError
 * that aborts the entire boot round instead of just skipping the duplicate.
 * Everything therefore lives inside this closure, and the registration at the
 * bottom is guarded as well.
 */
(function () {
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
    const HEADER_UTILITIES = 'conversation.session.header.utilities';
    const MAIN = 'main';
    const PANEL = 'sidebar.panellist';
    const PANEL_KEY = 'workspace-control';

  // Page-wide, not per-apply: the loader can run `apply` twice on one page
  // (boot, then an HMR rebuild), and the seats the first run filled must stay
  // claimed until the plugin that filled them is disposed.
  const seated = new Set();

    // One place for the numbers and tones the UI repeats: a result banner lives
    // for a moment, and every accent is the same three channels.
    const DISMISS_MS = 6000;
    const ACCENT_RGB = '88,101,242';
    const WARN_RGB = '240,180,80';
    const DANGER_RGB = '255,120,120';
    const DANGER_TEXT = 'var(--dsw-alias-label-error,#e06a6a)';

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
    const bootUrlListCodec = codec('BootUrlList', (value) => {
      if (!Array.isArray(value)) throw new Error('Expected an array of bundle urls');
      return value
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter((entry) => entry !== '');
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
      method('probeAgent', [{ wire: 'sessionId', codec: sessionIdCodec }]),
      method('releaseSession', [{ wire: 'sessionId', codec: sessionIdCodec }]),
      method('probeRestart', []),
      method('clientModule', []),
      method('pinBoot', [{ wire: 'urls', codec: bootUrlListCodec }]),
      method('refresh', []),
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
      refreshDsh: { zh: '刷新界面', en: 'Refresh UI' },
      refreshHint: {
        zh: '重新发布插件改动并重载页面，界面状态会重置；正在生成的那一轮不会被中断。',
        en: 'Republish plugin changes and reload the page; interface state resets. A turn in progress is not interrupted.',
      },
      refreshing: { zh: '正在刷新…', en: 'Refreshing…' },
      refreshedHot: {
        zh: '已热更新 {n} 个插件，页面没有重载。',
        en: 'Hot-swapped {n} plugin(s); the page was not reloaded.',
      },
      refreshedCurrent: {
        zh: '没有插件改动，界面已是最新。',
        en: 'No plugin changed; the interface is already current.',
      },
      refreshSplash: { zh: '正在刷新页面…', en: 'Refreshing the page…' },
      refreshBlocked: {
        zh: '这次没有重载页面：Host 还不能保证旧页面重载后可以正常启动，已改为热同步。重启一次 DSH 之后再刷新就会真正重载。',
        en: 'The page was not reloaded: the Host cannot guarantee the old manifest still boots, so it hot-synced instead. After one DSH restart, refresh will really reload.',
      },
      refreshedNeedsRestart: {
        zh: '热更新没有生效：这个页面和当前的 Host 不是同一版本。插件改动需要重启 DSH 才会完整生效。',
        en: 'The hot swap did not take effect: this page belongs to a different Host release. Restart DSH to pick up the plugin change in full.',
      },
      refreshedPlugins: {
        zh: '已重载 {n} 个在跑的插件代码，页面没有重载。',
        en: 'Reloaded the code of {n} running plugin(s); the page was not reloaded.',
      },
      refreshedPartial: {
        zh: '插件已重载，但有 {n} 个入口没有就绪，界面可能不完整。',
        en: 'Plugins reloaded, but {n} entry point(s) did not come back; the interface may be incomplete.',
      },
      refreshNoHmr: {
        zh: '这个构建没有热更新服务，插件代码没有重载，界面已刷新。',
        en: 'This build offers no hot-reload service, so plugin code was not reloaded; the interface was refreshed.',
      },
      refreshReloadFailed: {
        zh: '界面已刷新，但插件代码重载失败。',
        en: 'The interface was refreshed, but the plugin code could not be reloaded.',
      },
      refreshUnsupported: {
        zh: '这个构建没有可用的客户端模块表，界面无法刷新。',
        en: 'This build exposes no client module table, so the interface cannot be refreshed.',
      },
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
        refreshed: { zh: '界面已刷新。', en: 'The interface is refreshed.' },
        'refreshed-unchanged': {
          zh: '没有插件改动，界面保持原样。',
          en: 'No plugin changed; the interface was left as it is.',
        },
        'refreshed-hot': {
          zh: '已热更新插件，页面没有重载。',
          en: 'Plugins were hot-swapped; the page was not reloaded.',
        },
        'refreshed-needs-restart': {
          zh: '热更新没有生效，插件改动需要重启 DSH 才会完整生效。',
          en: 'The hot swap did not take effect; restart DSH to apply the plugin change in full.',
        },
        'refresh-unsupported': {
          zh: '这个构建没有可用的客户端模块表，界面无法刷新。',
          en: 'This build exposes no client module table, so the interface cannot be refreshed.',
        },
        'refreshed-plugins': {
          zh: '在跑的插件代码已重载，页面没有重载。',
          en: 'The code of the running plugins was reloaded; the page was not reloaded.',
        },
        'refreshed-partial': {
          zh: '插件已重载，但有入口没有就绪，界面可能不完整。',
          en: 'Plugins reloaded, but some entry points did not come back; the interface may be incomplete.',
        },
        'refresh-no-hmr': {
          zh: '这个构建没有热更新服务，插件代码没有重载，界面已刷新。',
          en: 'This build offers no hot-reload service, so plugin code was not reloaded; the interface was refreshed.',
        },
        'refresh-reload-failed': {
          zh: '界面已刷新，但插件代码重载失败。',
          en: 'The interface was refreshed, but the plugin code could not be reloaded.',
        },
        'refresh-failed': { zh: '刷新失败了。', en: 'The refresh failed.' },
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
        const service = optionalService(ctxRef, 'locale');
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
      // Refresh runs on its own axis: it must stay usable while the panel is
      // idle, and it must not be disabled by an unrelated move's phase.
      refreshPhase: 'idle',
      refreshNotice: null,
    };

    const listeners = new Set();
    const emit = () => {
      for (const listener of listeners) listener();
    };
    let dismissTimer = null;
    // A corner-button outcome is shown away from the panel, so it has its own
    // timer: clearing a panel result must never eat a toast (or the reverse).
    let noticeTimer = null;

    const armNotice = (ms) => {
      if (noticeTimer !== null) clearTimeout(noticeTimer);
      noticeTimer = setTimeout(() => {
        noticeTimer = null;
        patch({ refreshNotice: null });
      }, ms);
    };

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
      const remote = optionalService(ctxRef, 'remote');
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
    const OK_CODES = new Set([
      'moved',
      'attached',
      'rebuilt',
      'merged',
      'retitled',
      'removed',
      'refreshed',
      'refreshed-unchanged',
    ]);
    const PARTIAL_CODES = new Set([
      'moved-unverified',
      'moved-unattached',
      'moved-unreprojected',
      'attached-unreprojected',
      'merged-partial',
      'refreshed-hot',
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
            borderRadius: 'var(--dsw-radius-md, 8px)',
            background: hover ? 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.16))' : 'transparent',
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
            width: 16,
            height: 16,
            'aria-hidden': true,
            style: { flex: '0 0 auto', opacity: 0.75 },
          },
          h('path', {
            d: 'M2.5 4.5h4l1.2 1.5h5.8v6.2a.8.8 0 0 1-.8.8H3.3a.8.8 0 0 1-.8-.8z',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.5,
            strokeLinejoin: 'round',
          }),
          h('path', {
            d: 'M9.4 7.2v3.2M7.8 8.8l1.6-1.6 1.6 1.6',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.5,
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
      background: 'rgba(0,0,0,0.42)',
    };

    const cardStyle = {
      width: 'min(520px, calc(100vw - 32px))',
      boxSizing: 'border-box',
      padding: '20px 20px 16px',
      borderRadius: 'var(--dsw-radius-xl, 14px)',
      background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.12))',
      color: 'var(--dsw-alias-label-primary, inherit)',
      border: '0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2))',
      boxShadow: '0 24px 64px rgba(0,0,0,0.28)',
      fontSize: 13,
      lineHeight: 1.5,
    };

    const labelStyle = {
      display: 'block',
      marginBottom: 6,
      fontSize: 12,
      color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.95))',
    };

    const inputStyle = {
      flex: '1 1 auto',
      width: 'auto',
      minWidth: 0,
      boxSizing: 'border-box',
      padding: '8px 10px',
      borderRadius: 'var(--dsw-radius-md, 8px)',
      border: '0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2))',
      background: 'var(--dsw-alias-bg-l2, rgba(127,127,127,0.08))',
      color: 'inherit',
      font: 'inherit',
    };

    const buttonStyle = (primary, disabled) => ({
      padding: '8px 14px',
      borderRadius: 'var(--dsw-radius-md, 8px)',
      border: primary ? '0' : '0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.24))',
      background: primary ? 'var(--dsw-alias-button-primary-fill, #5865f2)' : 'transparent',
      color: primary ? 'var(--dsw-alias-label-primary-inverted, #fff)' : 'inherit',
      font: 'inherit',
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.65 : 1,
      whiteSpace: 'nowrap',
      flexShrink: 0,
    });

    const monoStyle = {
      fontFamily: 'var(--dsw-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
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
      .wsm-root{display:flex;flex-direction:column;gap:14px;padding:calc(28px + var(--dsh-frame-top-clearance,0px)) 0 32px;color:var(--dsw-alias-label-primary,#8a8a8a);font-size:13px;line-height:1.55}
      /* Market-page rhythm: a fluid 16-48px gutter that turns into a centred
         960px column on wide frames, so content never touches the edges. */
      .wsm-page{display:flex;flex-direction:column;gap:14px;min-width:0;
        padding-left:max(max(16px,min(4vw,48px)),50% - 480px);
        padding-right:max(max(16px,min(4vw,48px)),50% - 480px)}
      /* Settings: the dialog owns both the frame and the scroller. */
      .wsm-root--section{padding:0;height:auto;overflow:visible}
      .wsm-root--section .wsm-title{display:none}
      .wsm-page--section{padding-left:0;padding-right:0;max-width:none}
      .wsm-root :focus-visible{outline:2px solid var(--dsw-focus-ring-color,rgba(88,101,242,.65));outline-offset:2px}
      .wsm-headActions{display:flex;align-items:center;gap:8px}
      .wsm-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
      .wsm-headText{min-width:0}
      .wsm-title{margin:0;font-size:15px;font-weight:600;line-height:22px}
      .wsm-sub{margin:4px 0 0;font-size:12px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.95))}
      .wsm-ghost{appearance:none;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));background:transparent;color:var(--dsw-alias-label-secondary,rgba(127,127,127,1));border-radius:var(--dsw-radius-md,8px);padding:4px 10px;font:inherit;font-size:12px;cursor:pointer;transition:background .16s,border-color .16s,color .16s}
      .wsm-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));border-color:var(--dsw-alias-border-l3,rgba(127,127,127,.32));color:var(--dsw-alias-label-primary,#8a8a8a)}
      .wsm-ghost:disabled{opacity:.45;cursor:default}
      .wsm-primary{appearance:none;border:0;border-radius:var(--dsw-radius-md,8px);padding:5px 14px;font:inherit;font-size:12px;font-weight:500;cursor:pointer;background:var(--dsw-alias-button-primary-fill,#5865f2);color:var(--dsw-alias-label-primary-inverted,#fff);transition:background .16s,opacity .16s}
      .wsm-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#4a56d8)}
      .wsm-primary:disabled{opacity:.45;cursor:default}
      .wsm-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(262px,1fr));gap:12px;margin:0;padding:0;list-style:none}
      .wsm-card{display:flex;flex-direction:column;gap:10px;padding:16px;border:.5px solid var(--dsw-alias-settings-card-stroke,rgba(127,127,127,.16));border-radius:var(--dsw-radius-xl,14px);background:var(--dsw-alias-settings-card-fill,rgba(127,127,127,.10));transition:border-color .16s,background .16s}
      .wsm-card:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));border-color:var(--dsw-alias-border-l3,rgba(127,127,127,.28))}
      .wsm-cardTop{display:flex;align-items:center;gap:8px;min-width:0}
      .wsm-dot{width:7px;height:7px;border-radius:50%;flex:none;box-shadow:0 0 0 3px color-mix(in srgb,currentColor 16%,transparent);background:currentColor}
      .wsm-dot-idle{color:var(--dsw-alias-state-success-primary,#4bbf83)}
      .wsm-dot-running{color:var(--dsw-alias-state-warn-primary,#e0a044)}
      .wsm-dot-missing{color:var(--dsw-alias-state-error-primary,#e06a6a)}
      .wsm-name{font-size:14px;font-weight:500;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .wsm-path{font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,monospace);font-size:12px;line-height:1.45;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.9));overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .wsm-path-wrap{white-space:normal;word-break:break-all}
      .wsm-meta{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8a);font-variant-numeric:tabular-nums}
      .wsm-sep{color:var(--dsw-alias-label-tertiary,#8a8a8a);opacity:.7}
      .wsm-state-warn{color:var(--dsw-alias-state-warn-label,#e0b060)}
      .wsm-state-info{color:var(--dsw-alias-label-secondary,#9a9a9a)}
      .wsm-state-danger{color:var(--dsw-alias-label-error,#e06a6a)}
      .wsm-note{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.95))}
      .wsm-note-warn{color:var(--dsw-alias-state-warn-label,#e0b060)}
      .wsm-foot{display:flex;flex-wrap:wrap;gap:6px;margin-top:auto;padding-top:8px;border-top:.5px solid var(--dsw-alias-separator-primary,rgba(127,127,127,.12))}
      .wsm-action{appearance:none;border:.5px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,rgba(127,127,127,1));border-radius:var(--dsw-radius-sm,6px);padding:4px 8px;font:inherit;font-size:12px;cursor:pointer;transition:background .16s,color .16s,border-color .16s}
      .wsm-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.22));color:var(--dsw-alias-label-primary,#8a8a8a)}
      .wsm-action-danger:hover:not(:disabled){color:var(--dsw-alias-label-error,#e06a6a);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e06a6a) 45%,transparent);background:var(--dsw-alias-interactive-bg-hover-danger,rgba(224,106,106,.12))}
      .wsm-action:disabled{opacity:.4;cursor:default}
      .wsm-empty{display:flex;flex-direction:column;align-items:center;gap:6px;grid-column:1/-1;padding:32px 16px;text-align:center;border:.5px dashed var(--dsw-alias-border-l2,rgba(127,127,127,.22));border-radius:var(--dsw-radius-xl,14px);color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.95))}
      .wsm-emptyTitle{font-size:13px;font-weight:500;color:var(--dsw-alias-label-secondary,rgba(127,127,127,1))}
      .wsm-skeleton{height:132px;border-radius:var(--dsw-radius-xl,14px);background:var(--dsw-alias-bg-skeleton,rgba(127,127,127,.10))}
      @media (prefers-reduced-motion:reduce){.wsm-card,.wsm-ghost,.wsm-action,.wsm-primary,.wsm-source,.wsm-modalCard{transition:none}}
      .wsm-modal{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.42);backdrop-filter:blur(1.5px)}
      .wsm-modalCard{width:100%;max-width:560px;max-height:86vh;overflow:auto;display:flex;flex-direction:column;border-radius:calc(var(--dsw-radius-xl,14px) + 2px);background:var(--dsw-alias-bg-l1,rgba(127,127,127,.14));box-shadow:0 24px 64px rgba(0,0,0,.28)}
      .wsm-modalCard .wsm-detail{max-width:none;border:none;border-radius:0;background:transparent}
      .wsm-modal .wsm-detail{max-width:560px}
      .wsm-detail{display:flex;flex-direction:column;gap:12px;padding:16px;max-width:560px;border:.5px solid var(--dsw-alias-settings-card-stroke,rgba(127,127,127,.16));border-radius:var(--dsw-radius-xl,14px);background:var(--dsw-alias-settings-card-fill,rgba(127,127,127,.10))}
      .wsm-detailHead{display:flex;align-items:baseline;gap:8px;min-width:0}
      .wsm-detailName{font-size:14px;font-weight:500;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .wsm-section{font-size:12px;font-weight:500;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.95))}
      .wsm-field{display:flex;flex-direction:column;gap:6px}
      .wsm-label{font-size:12px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.95))}
      .wsm-inline{display:flex;gap:8px;align-items:center}
      .wsm-input{flex:1;min-width:0;padding:8px 10px;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary,#8a8a8a);background:var(--dsw-alias-bg-l2,rgba(127,127,127,.10));border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));border-radius:var(--dsw-radius-md,8px)}
      .wsm-input:focus-visible{border-color:var(--dsw-alias-state-business-primary,#5865f2)}
      .wsm-sources{display:flex;flex-direction:column;gap:6px;max-height:300px;overflow-y:auto}
      .wsm-source{display:flex;align-items:center;gap:10px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.20));border-radius:var(--dsw-radius-lg,10px);cursor:pointer;transition:background .16s,border-color .16s}
      .wsm-source:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
      .wsm-source[data-picked=true]{border-color:var(--dsw-alias-state-business-primary,#5865f2);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#5865f2) 10%,transparent)}
      .wsm-source[data-blocked=true]{cursor:default;opacity:.65}
      .wsm-sourceName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
      .wsm-actions{display:flex;justify-content:flex-end;gap:8px;padding-top:2px}
      .wsm-check{display:flex;align-items:flex-start;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary,rgba(127,127,127,1));cursor:pointer}
      .wsm-check input{margin-top:2px}
      .wsm-error{color:var(--dsw-alias-label-error,#e06a6a);font-size:12px}
      /* Session-header refresh seat: an in-flow item of the header's utilities
         row, so it lines up beside DSH's own corner button instead of covering it. */
      .wsm-refreshSeat{display:flex;align-items:center;flex:none}
      .wsm-refreshBtn{display:grid;place-items:center;width:24px;height:24px;padding:0;color:var(--dsw-alias-label-secondary,rgba(127,127,127,1));background:transparent;border:.5px solid transparent;border-radius:var(--dsw-radius-sm,6px);cursor:pointer;transition:background .16s,border-color .16s,color .16s}
      .wsm-refreshBtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#8a8a8a)}
      .wsm-refreshBtn:disabled{cursor:default;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.95))}
      .wsm-spin{width:14px;height:14px;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:wsm-spin .7s linear infinite}
      @keyframes wsm-spin{to{transform:rotate(360deg)}}
      /* Refresh splash. A bundle swap finishes in well under a second, so the
         veil fades in only after 120ms and never appears for a fast refresh. */
      .wsm-loading{position:fixed;inset:0;z-index:90;display:flex;align-items:center;justify-content:center;pointer-events:none;background:rgba(0,0,0,0);animation:wsm-veil .18s ease-out .12s forwards}
      .wsm-loadingCard{display:flex;align-items:center;gap:10px;padding:12px 16px;font-size:12px;line-height:1.4;color:var(--dsw-alias-label-primary,#8a8a8a);background:var(--dsw-alias-bg-l3,rgba(30,30,32,.97));border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));border-radius:var(--dsw-radius-lg,10px);box-shadow:0 10px 30px rgba(0,0,0,.20);opacity:0;animation:wsm-card .18s ease-out .12s forwards}
      @keyframes wsm-veil{to{background:rgba(0,0,0,.24)}}
      @keyframes wsm-card{to{opacity:1}}
      .wsm-toast{position:fixed;right:16px;bottom:16px;z-index:80;max-width:min(46ch,calc(100vw - 32px));padding:10px 12px;font-size:12px;line-height:1.45;color:var(--dsw-alias-label-primary,#8a8a8a);background:var(--dsw-alias-bg-l3,rgba(30,30,32,.97));border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));border-left:2px solid var(--dsw-alias-state-business-primary,#5865f2);border-radius:var(--dsw-radius-md,8px);box-shadow:0 8px 24px rgba(0,0,0,.18)}
      .wsm-toast[data-tone=warn]{border-left-color:#d9a441}
      .wsm-toast[data-tone=error]{border-left-color:var(--dsw-alias-label-error,#e06a6a)}
      @media (prefers-reduced-motion:reduce){
        .wsm-spin{animation-duration:2.4s}
        .wsm-loading{animation:none;background:rgba(0,0,0,.24)}
        .wsm-loadingCard{animation:none;opacity:1}
      }
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
      const parts = [h('span', { key: 'sessions' }, countText(entry.sessions))];
      if (entry.running > 0) {
        parts.push(h('span', { key: 'sep1', className: 'wsm-sep', 'aria-hidden': true }, '·'));
        parts.push(
          h(
            'span',
            { key: 'running', className: 'wsm-state-warn', title: runningNames.join(' · ') },
            handlers.t('runningChip').replace('{n}', String(entry.running)),
          ),
        );
      } else if (entry.open > 0) {
        parts.push(h('span', { key: 'sep2', className: 'wsm-sep', 'aria-hidden': true }, '·'));
        parts.push(
          h(
            'span',
            { key: 'open', className: 'wsm-state-info', title: openNames.join(' · ') },
            handlers.t('openChip').replace('{n}', String(entry.open)),
          ),
        );
      }
      if (entry.exists === false) {
        parts.push(h('span', { key: 'sep3', className: 'wsm-sep', 'aria-hidden': true }, '·'));
        parts.push(h('span', { key: 'missing', className: 'wsm-state-danger' }, handlers.t('missingDir')));
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
        h('div', { className: 'wsm-meta' }, ...parts),
        h('div', { className: 'wsm-path', title: entry.path }, entry.path),
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
      // Settings mounts the manager with variant 'section': the dialog already
      // owns the page frame and the scroller, so the panel drops its own.
      const section = Boolean(props && props.variant === 'section');
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
                {
                  type: 'button',
                  className: 'wsm-ghost',
                  onClick: () => runRefresh('panel'),
                  disabled: state.refreshPhase === 'running',
                  title: t('refreshHint'),
                },
                state.refreshPhase === 'running' ? t('refreshing') : t('refreshDsh'),
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
      // Occupancy is explained once, under the head, instead of on every card:
      // the cards only carry the count and the state word.
      if (view === 'list' && Array.isArray(list)) {
        const runningTotal = list.reduce((total, entry) => total + (entry.running || 0), 0);
        const openTotal = list.reduce((total, entry) => total + (entry.open || 0), 0);
        if (runningTotal > 0) {
          notes.push(h('p', { className: 'wsm-note', key: 'held' }, t('busyHint')));
        } else if (openTotal > 0) {
          notes.push(h('p', { className: 'wsm-note', key: 'held' }, t('openHint')));
        }
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
                className: 'wsm-ghost',
                onClick: () => runRefresh('panel'),
                disabled: state.refreshPhase === 'running',
                title: t('refreshHint'),
              },
              state.refreshPhase === 'running' ? t('refreshing') : t('refreshDsh'),
            ),
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
                      h('span', { className: 'wsm-state-info' }, countText(entry.sessions)),
                      blocked
                        ? h(
                            'span',
                            { className: 'wsm-state-warn' },
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
                style: { background: 'var(--dsw-alias-state-error-primary,#e06a6a)' },
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

      return h(
        'div',
        { className: section ? 'wsm-root wsm-root--section' : 'wsm-root' },
        h(
          'div',
          { className: section ? 'wsm-page wsm-page--section' : 'wsm-page' },
          head,
          ...notes,
          listBody,
        ),
        modal,
      );
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
     * Settings renders the manager itself.
     *
     * `settings.section` mounts inside the settings dialog, which already owns
     * the page frame and the scroller. The manager therefore drops its own frame
     * (`variant: 'section'`): one click on the section already shows the page,
     * instead of making the reader press a second button for the same manager.
     */
    function SettingsEntry() {
      return h(WorkspacePanel, { variant: 'section' });
    }

    /** The round-arrow glyph for the header refresh seat. */
    function RefreshGlyph() {
      return h(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M13.2 8a5.2 5.2 0 1 1-1.53-3.68' }),
        h('path', { d: 'M13.4 2.9v2.6h-2.6' }),
      );
    }

    /**
     * The session-header refresh seat.
     *
     * It rides in `conversation.session.header.utilities`, the public list slot
     * that the conversation header lays out with flexbox just before its corner
     * seat — the seat DSH's own "open sidebar" button owns. Being in that flow is
     * the whole point: two flex items cannot cover each other, while a fixed
     * overlay in the same corner did.
     */
    function HeaderRefresh() {
      const state = useStore();
      const running = state.refreshPhase === 'running';
      return h(
        'div',
        { className: 'wsm-refreshSeat', key: 'refresh' },
        h(
          'button',
          {
            type: 'button',
            className: 'wsm-refreshBtn',
            onClick: () => runRefresh('header'),
            disabled: running,
            title: running ? t('refreshing') : t('refreshHint'),
            'aria-label': t('refreshDsh'),
            'data-running': running ? 'true' : 'false',
          },
          running ? h('span', { className: 'wsm-spin', 'aria-hidden': 'true' }) : RefreshGlyph(),
        ),
      );
    }

    /** Outcome of a corner refresh, announced politely and retired on its own. */
    function RefreshToast() {
      const state = useStore();
      const notice = state.refreshNotice;
      if (!notice) return null;
      return h(
        'div',
        {
          className: 'wsm-toast',
          key: 'toast',
          role: 'status',
          'aria-live': 'polite',
          'data-tone': notice.tone || 'ok',
        },
        notice.text,
      );
    }

    /**
     * What a refresh looks like while it runs.
     *
     * This is deliberately not DSH's own boot screen: a hot swap never reloads
     * the document, so the boot splash cannot appear. The veil marks the few
     * hundred milliseconds in which the fiber tree is replaced.
     */
    function RefreshSplash() {
      const state = useStore();
      if (state.refreshPhase !== 'running') return null;
      return h(
        'div',
        { className: 'wsm-loading', key: 'loading', role: 'status', 'aria-live': 'polite' },
        h(
          'div',
          { className: 'wsm-loadingCard' },
          h('span', { className: 'wsm-spin', 'aria-hidden': 'true' }),
          h('span', null, t('refreshSplash')),
        ),
      );
    }

    /** Permanent overlay: the toast and the session dialog outlive each other. */
    function Shell() {
      const state = useStore();
      const open = state.open === true && state.mode === 'session';
      return h(
        React.Fragment,
        null,
        h(RefreshSplash, { key: 'splash' }),
        h(RefreshToast, { key: 'toast' }),
        open ? h(Dialog, { key: 'dialog' }) : null,
      );
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
     * Whether this page may rebuild itself by reloading the document.
     *
     * The rule mirrors refresh.js on the Host half, which this bundle cannot
     * import. Only a plain web page reloads: the desktop shell freezes its boot
     * manifest at window start, and one crash proved that even a matching
     * revision can mix two generations in that manifest, so a reload there can
     * ask for plugin batch URLs that no longer exist and kill the boot.
     */
    function decideRefresh({ isDesktop, bootRev, liveRev, changed }) {
      if (!isDesktop) return { action: 'reload', reason: 'web' };
      if (Array.isArray(changed) && changed.length > 0) return { action: 'sync', reason: 'changed' };
      const known = (rev) => typeof rev === 'string' && rev !== '';
      if (!known(bootRev) || !known(liveRev)) return { action: 'sync', reason: 'unknown' };
      if (bootRev !== liveRev) return { action: 'sync', reason: 'stale-boot' };
      return { action: 'sync', reason: 'current' };
    }

    /**
     * Republish plugin bundles, then rebuild the interface for real: reload the
     * document whenever the Host still serves the exact boot bundles this page
     * started from. On the desktop shell that is only guaranteed after the page
     * reported its manifest (pinBoot); until then the click hot-syncs in place
     * instead of risking a boot that cannot start.
     */
    async function runRefresh(source) {
      if (store.refreshPhase === 'running') return;
      patch({ refreshPhase: 'running', refreshNotice: null });

      // Set once the Host reported whether a document load is still safe. The
      // last sentence of a success is where a warning about reloading belongs.
      let extra = '';
      const finish = (code, message, tone) => {
        const text = extra !== '' && (tone === 'ok' || tone === 'warn') ? `${message} ${extra}` : message;
        // The boot reconcile runs on its own; it must not leave a result card
        // behind or announce itself, only release the spinner.
        if (source === 'silent') {
          patch({ refreshPhase: 'idle' });
          return;
        }
        if (source === 'header') {
          patch({ refreshPhase: 'idle', refreshNotice: { tone, text } });
          armNotice(DISMISS_MS);
          return;
        }
        patch({ refreshPhase: 'idle', phase: 'done', result: { code, message: text } });
      };

      let settled;
      try {
        settled = settle(await callRemote('refresh'));
      } catch (error) {
        settled = { error: describeError(error) };
      }

      if (settled.error) {
        patch({ refreshPhase: 'idle' });
        if (source === 'header') {
          patch({ refreshNotice: { tone: 'error', text: settled.error } });
          armNotice(DISMISS_MS);
        } else {
          patch({ phase: 'error', error: settled.error });
        }
        return;
      }

      const value = settled.value || settled.refusal || null;
      if (!value || value.status === 'error') {
        const code = value && typeof value.code === 'string' ? value.code : 'refresh-failed';
        const text = code === 'unsupported' ? t('refreshUnsupported') : codeText(code);
        finish(code === 'unsupported' ? 'refresh-unsupported' : 'refresh-failed', text, 'error');
        return;
      }

      const liveRev = typeof value.rev === 'string' ? value.rev : null;
      const changed = Array.isArray(value.changed) ? value.changed : [];
      // The Host retains the boot-generation bundles so a document load cannot
      // 404 mid-boot; when it could not, say so: another plugin's reload button
      // (or F5) is then the thing that breaks startup.
      const reload = value.reload && typeof value.reload === 'object' ? value.reload : null;
      // The Host half reloads plugin code before republishing bundles. Its report
      // is three-way on purpose: plugins can reload while the page sync fails, or
      // the interface can refresh while the plugin set still needs a restart.
      const plugins = value.plugins && typeof value.plugins === 'object' ? value.plugins : null;
      const applied = plugins && Array.isArray(plugins.applied) ? plugins.applied.length : 0;
      const unhealthy = plugins && Array.isArray(plugins.pending) ? plugins.pending.length : 0;
      const warned = plugins && Array.isArray(plugins.warnings) ? plugins.warnings.length : 0;
      const restartReason =
        plugins && typeof plugins.restartReason === 'string' && plugins.restartReason !== ''
          ? plugins.restartReason
          : null;
      const restartOnly = plugins !== null && plugins.restartOnly === true;

      const boot = globalThis.__DSH_BOOT__;
      const bootRev = boot && typeof boot.rev === 'string' ? boot.rev : null;
      const isDesktop =
        (typeof globalThis.location !== 'undefined' && globalThis.location.protocol === 'dsh-app:') ||
        typeof globalThis.dshDesktopBoot !== 'undefined';

      const decision = decideRefresh({ isDesktop, bootRev, liveRev, changed });
      // A real refresh: reload the document whenever the Host guarantees the
      // frozen boot manifest still resolves. The veil stays up until the new
      // document replaces this one. The silent boot reconcile must never reload
      // (the reloaded page would boot the same stale manifest again).
      // `supported` is the newer Host's promise that it pinned this page's exact
      // manifest; without it (an older Host) a reload could still 404 mid-boot.
      const reloadSafe = reload !== null && reload.safe === true && reload.supported === true;
      const silent = source === 'silent';
      const reloading = !silent && (decision.action === 'reload' || (isDesktop && reloadSafe));
      if (reloading && typeof globalThis.location !== 'undefined' && typeof globalThis.location.reload === 'function') {
        globalThis.location.reload();
        return;
      }
      if (!reloading && isDesktop && reloadSafe === false && !silent) {
        // Explain why this click fell back to a hot sync instead of reloading.
        extra = [extra, t('refreshBlocked')].filter((part) => part !== '').join(' ');
      }

      // Nothing was republished and the page already runs the live graph, so
      // there is no graph to sync. Host plugin code may still have been reloaded,
      // and that outcome is reported below instead of doing nothing visibly.
      const current = decision.reason === 'current';

      // A graph from another Host release is refused by the page runtime (it
      // only applies graphs of its boot release), so syncing it would report a
      // success that never happened. Say plainly that a restart is needed.
      if (!current) {
        const bootRelease = boot && boot.release ? boot.release : null;
        const liveRelease = value.graph && value.graph.release ? value.graph.release : null;
        const sameRelease =
          (bootRelease === null && liveRelease === null) ||
          (bootRelease !== null &&
            liveRelease !== null &&
            bootRelease.version === liveRelease.version &&
            (bootRelease.commit ?? '') === (liveRelease.commit ?? ''));
        if (!sameRelease) {
          finish('refreshed-needs-restart', t('refreshedNeedsRestart'), 'warn');
          return;
        }
      }

      // The live graph is passed in because the in-page runtime cannot fetch it
      // on its own; syncing it hot-swaps changed fibers without a document load.
      let synced = current;
      if (!current) {
        const modules = optionalService(ctxRef, 'modules');
        if (modules && modules.entries && typeof modules.entries.sync === 'function' && value.graph) {
          try {
            await modules.entries.sync(value.graph);
            synced = true;
          } catch {
            synced = false;
          }
        }
      }

      if (!synced) {
        finish('refreshed-needs-restart', t('refreshedNeedsRestart'), 'warn');
        return;
      }

      // Plugin code that could not reload is still worth reporting even when the
      // interface itself was republished: the two halves fail independently.
      if (value.code === 'no-hmr') {
        finish('refresh-no-hmr', t('refreshNoHmr'), 'warn');
        return;
      }
      if (value.code === 'reload-failed') {
        finish('refresh-reload-failed', t('refreshReloadFailed'), 'warn');
        return;
      }
      // A restartReason that is only about where a package is mapped does not
      // stop the page: the files that run now are the ones the next page loads.
      if (restartReason !== null && !restartOnly) {
        finish('refreshed-needs-restart', t('refreshedNeedsRestart'), 'warn');
        return;
      }
      if (unhealthy > 0 || warned > 0) {
        finish('refreshed-partial', t('refreshedPartial').replace('{n}', String(unhealthy + warned)), 'warn');
        return;
      }
      if (changed.length === 0 && applied > 0) {
        finish('refreshed-plugins', t('refreshedPlugins').replace('{n}', String(applied)), 'ok');
        return;
      }

      const text =
        changed.length > 0
          ? t('refreshedHot').replace('{n}', String(changed.length))
          : t('refreshedCurrent');
      finish(changed.length > 0 ? 'refreshed-hot' : 'refreshed-unchanged', text, 'ok');
    }

    /**
     * Tell the Host which bundle URLs this document actually booted from.
     *
     * The desktop shell replays its frozen boot manifest into every later
     * document load, so a reload is only safe while exactly those URLs stay
     * resolvable on the Host. Reported once per page load.
     */
    async function reportBootPins() {
      if (globalThis.__wsmBootPinned) return;
      const boot = globalThis.__DSH_BOOT__;
      if (!boot || typeof boot !== 'object') return;
      const urls = [];
      const collect = (rows) => {
        if (!Array.isArray(rows)) return;
        for (const row of rows) {
          if (row && typeof row.url === 'string' && row.url !== '') urls.push(row.url);
        }
      };
      collect(boot.entries);
      collect(boot.batches);
      if (urls.length === 0) return;
      try {
        const settled = settle(await callRemote('pinBoot', urls));
        if (settled.error || !settled.value || settled.value.status === 'error') return;
        globalThis.__wsmBootPinned = true;
      } catch {
        /* the next page load reports again */
      }
    }

    /**
     * Heal a page that booted from a stale manifest.
     *
     * The desktop shell freezes the Host's boot payload at window start, so a
     * later document load can run an older bundle graph than the Host serves.
     * Ask for the live revision once per page load and, when it differs, run the
     * ordinary refresh (a hot sync, never a reload). Every failure stays silent:
     * this is a repair, not an action the user asked for.
     */
    async function reconcileBootGraph() {
      const boot = globalThis.__DSH_BOOT__;
      const bootRev = boot && typeof boot.rev === 'string' ? boot.rev : null;
      if (!bootRev) return;
      if (globalThis.__wsmBootReconciled === bootRev) return;
      globalThis.__wsmBootReconciled = bootRev;
      let settled;
      try {
        settled = settle(await callRemote('clientModule'));
      } catch {
        return;
      }
      const value = settled.value || settled.refusal || null;
      if (!value || value.status === 'error' || typeof value.rev !== 'string') return;
      if (value.rev === bootRev) return;
      await runRefresh('silent');
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
      // Only `slots` is required. Every other service this half uses is read
      // through `ctx.get`: a service listed here that the Client context does
      // not bind leaves the whole fiber pending, and a pending fiber renders
      // nothing at all — the failure mode users see as "enabled but dead".
      // `remote` in particular only exists once the gateway has a connection.
      inject: ['slots'],
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
          if (noticeTimer !== null) {
            clearTimeout(noticeTimer);
            noticeTimer = null;
          }
          patch({ open: false, phase: 'idle', result: null, error: null, refreshPhase: 'idle', refreshNotice: null });
          listeners.clear();
        });

        // Mount eagerly when the gateway is already there; otherwise the first
        // interaction mounts it. Wrapped because a Client context that binds
        // `remote` differently must not cost us the registrations below.
        try {
          armScopedInject(ctx);
          ensureNamespace().catch(() => {
            /* the UI stays visible; opening it reports the failure */
          });
        } catch (error) {
          console.error('[dsh-workspace-control] remote wiring failed', error);
        }

        // Tell the Host which manifest this page booted from, so it can keep
        // those exact bundles resolvable for a real reload. Retried once because
        // the gateway may still be connecting during the first paint.
        setTimeout(() => {
          reportBootPins().catch(() => {
            /* the next page load reports again */
          });
        }, 300);

        // One boot-time reconcile, after the gateway has had time to connect.
        // See reconcileBootGraph: a page that booted from a stale Host manifest
        // would otherwise keep running bundle bytes the Host has replaced.
        setTimeout(() => {
          reportBootPins().catch(() => {});
          reconcileBootGraph().catch(() => {
            /* a repair that cannot run is not worth a message */
          });
        }, 1200);

        // Dictionaries go in through the per-locale form: the namespace is not
        // part of the compile-time merge table, and one locale failing here must
        // never take the whole Client half down.
        const locale = optionalService(ctx, 'locale');
        if (locale && typeof locale.register === 'function') {
          ctx.effect(() => {
            const disposers = [];
            for (const language of ['en', 'zh']) {
              try {
                disposers.push(locale.register(NS, language, flatten(language)));
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

        // A page can mount this bundle more than once: the loader re-applies
        // every contribution after an HMR rebuild, and a second `apply` on one
        // page meets the seats the first one already filled. Cordis refuses a
        // duplicate key/id loudly — an uncaught error that aborts the rest of
        // `apply` and leaves the plugin half-wired — so every seat is claimed
        // once and handed back with this plugin's own effect.
        const seat = (slot, options, component) => {
          const key = `${slot}:${options.key ?? options.id}`;

          ctx.slots.inject(slot, () => {
            if (seated.has(key)) {
              console.warn(`[${PACKAGE}] ${key} is already on this page; skipping the duplicate`);
              return undefined;
            }

            seated.add(key);

            let dispose;
            try {
              dispose = ctx.slots.register({ name: slot, ...options }, component);
            } catch (error) {
              seated.delete(key);
              console.error(`[${PACKAGE}] could not fill ${key}`, error);
              return undefined;
            }

            return () => {
              seated.delete(key);
              try {
                dispose?.();
              } catch {
                /* the whole plugin is going away anyway */
              }
            };
          });
        };

        seat(SLOT, { id: 'workspace-control-move', order: 500, locale: NS }, MenuRow);

        seat(OVERLAY, { id: 'workspace-control-dialog', order: 40, locale: NS }, Shell);

        // Refresh lives in the conversation header's utilities list: the rightmost
        // item of that row, immediately beside the corner button DSH fills with
        // "open sidebar". Order 50 keeps it there without racing other plugins
        // (open-in-app uses -10, schedule -5).
        seat(HEADER_UTILITIES, { id: 'workspace-control-refresh', order: 50, locale: NS }, HeaderRefresh);

        // The workspace row's own "..." menu has no extension slot (the whole
        // browser region is a single `shadows-shipped-ui` hole), so workspace
        // management gets its own central panel: a sidebar entry plus the panel
        // the entry dispatches, both keyed by the same id.
        seat(MAIN, { key: PANEL_KEY, locale: NS }, WorkspacePanel);

        // Settings is the third door to the same panel, so the feature is
        // discoverable from where users look for configuration.
        seat(SETTINGS, { id: 'workspace-control-settings', order: 25, locale: NS, label: () => t('panelTitle') }, SettingsEntry);

        // The sidebar owns this button and addresses the main panel by list id.
        seat(PANEL, { id: PANEL_KEY, order: 20, locale: NS, label: () => t('panelTitle') }, PanelIcon);
      },
    };
}

/**
 * Register the Client half without throwing out of this script.
 *
 * The platform runs every immediate bundle once on its own and again inside the
 * composed batch, so a second registration is expected. A throw here is fatal
 * for the whole boot ("web boot: N entries did not activate"), so the duplicate
 * case is downgraded to a warning and every other failure is logged and drawn
 * as a banner instead of escaping the script.
 */
function registerClientModule(spec) {
  try {
    window.__ModuleLoader__.load(spec);
  } catch (error) {
    const text = String((error && error.message) || error);
    if (/duplicate|already|registered/i.test(text)) {
      console.warn('[dsh-workspace-control] the client half is already on this page; skipping the duplicate registration');
      return;
    }
    console.error('[dsh-workspace-control] the client half could not be registered', error);
    try {
      const banner = document.createElement('div');
      banner.setAttribute('data-workspace-control-error', '');
      banner.textContent = ['workspace control: registration failed', text.slice(0, 400)].join(
        String.fromCharCode(10),
      );
      banner.style.cssText =
        'position:fixed;left:12px;bottom:12px;z-index:2147483647;max-width:44ch;' +
        'padding:10px 12px;border-radius:10px;font:12px/1.45 ui-monospace,monospace;' +
        'white-space:pre-wrap;color:#ffb4b4;background:rgba(40,16,20,.94);' +
        'border:1px solid rgba(255,120,120,.45)';
      (document.body || document.documentElement).appendChild(banner);
    } catch {
      /* nothing left to report to */
    }
  }
}

registerClientModule({
  id: 'dsh-workspace-control',
  factory(require) {
    try {
      return build(require);
    } catch (error) {
      // A throw in this factory aborts the whole Web boot ("1 entry did not
      // activate") and leaves the user with an application that will not
      // start, so this half degrades to a visible banner instead of silence:
      // "plugin enabled but nothing works" is unactionable for a user.
      console.error('[dsh-workspace-control] failed to build the client half', error);
      try {
        const text = String((error && error.stack) || error).slice(0, 600);
        const banner = document.createElement('div');
        banner.setAttribute('data-workspace-control-error', '');
                banner.textContent = ['workspace control failed to load', text].join(String.fromCharCode(10));
        banner.style.cssText =
          'position:fixed;left:12px;bottom:12px;z-index:2147483647;max-width:44ch;' +
          'padding:10px 12px;border-radius:10px;font:12px/1.45 ui-monospace,monospace;' +
          'white-space:pre-wrap;color:#ffb4b4;background:rgba(40,16,20,.94);' +
          'border:1px solid rgba(255,120,120,.45)';
        (document.body || document.documentElement).appendChild(banner);
      } catch {
        /* nothing left to report to */
      }
      return { inject: [], apply() {} };
    }
  },
});

})();
