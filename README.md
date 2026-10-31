# Workspace Manager

One panel for DeepSeek Harness workspaces: rename, delete, rebuild onto another
directory, merge, and move single sessions between them — without losing
anything. A session's working directory is baked into its stored header and into
the session-store directory name, so the UI cannot change it after creation; this
plugin does that through the supported persistence seam.

## What it does

The manager lives in its own central panel, opened from its icon in the sidebar's
panel row (工作区管理 / Workspace manager):

| Action | What happens |
| --- | --- |
| **重建… / Rebuild…** | Pick a new directory for a whole workspace. Every session it holds moves with it, the record at the new path inherits the title and the sidebar position, and the old record is removed once it is empty. |
| **合并… / Merge…** | Pick other workspaces. Their sessions move into this one's directory, and a source record is dropped once nothing is left in it. |
| **重命名 / Rename** | Change only the sidebar title. The directory is untouched. |
| **删除 / Delete** | Remove the workspace record. Its sessions are archived first, and the directory with all session files stays on disk — the workspace can be added back at the same path later. |

Every row also reports, *before anything is clicked*:

- how many sessions the directory really holds;
- **占用 N / N held** — how many of those cannot move right now, because a turn is
  running (`running`) or because the app still holds the session log (`open`, which
  makes the store refuse to publish a successor artifact). Rebuild, merge and
  delete stay disabled on such a row, and the held sessions are named in the row,
  so a refusal is visible up front instead of arriving after the fact.

Single sessions still have their own entry: **移动到工作区… / Move to workspace…** in
the session row's `...` menu moves just that session to a directory. If the target
is already a workspace, the session joins it; if not, the workspace is created.

The move keeps the session id, title, every committed event (history, tool calls,
approvals) and the format version, then regroups the session under the workspace
that owns the target directory. If that workspace does not exist yet, it is
created.

## How the move works

The session store is append-only and refuses rewritten history, so the move
materializes a **successor artifact** through the supported persistence seam
instead of editing bytes:

1. `sessionPersistence.stat(id)` — read the header (id, version, cwd, lineage).
2. `sessionPersistence.open(id, 'read')` — copy every committed event. A read
   handle never takes write ownership, so this works while the UI holds the
   session open.
3. Park the old session directory (atomic rename, same volume), so the id leaves
   the store before the successor claims it.
4. `sessionPersistence.create({ ...header, cwd }, { inheritedEventCount })` +
   `append(events)` + `flush()` — the backend writes a correct header frame with
   the new `cwd` in the current format.
5. Read back `stat(id)` and verify the stored `cwd`; then update the workspace
   registry: `resolveByPath(target) ?? create(target)`, `attachSession(id)`, and
   `detachSession(id)` on the old workspace.

Failure handling: if step 4 fails, the parked directory is renamed back and the
result says the move was rolled back. A rebuild rolls every session it already
moved back to the old directory, and removes the record it created at the target.

Two different states are refused up front, and the difference matters:

- `running` — a turn is in flight. A live agent keeps the old directory as its
  process cwd and permission root, so moving under it would be wrong. The signal
  is the turn boundary in the session log (`turn/start` with no `turn/end` after
  it), **not** `agents.get(id)`: an idle session that the app merely has open also
  has a live agent, which is why the sidebar can say 「空闲」 while a naive check
  says "running".
- `session-open` — the session is open in the app, so its log is in memory and the
  store owns that id. `create` then refuses the successor ("already exists"), so
  the move cannot work until the tab is closed; refusing here names the real
  reason instead of failing halfway through a rebuild.

Two more guards keep a half-done move from eating history:

- A header-only session (no committed events) is refused, because `create` writes
  nothing and only the first `append` publishes — moving it would delete the
  original and produce no successor.
- If the store still reports the id right after the directory was parked (an
  index-based resolution), the parked copy is restored and the move reports
  `store-cached` instead of failing with a misleading write error.

After a move the registry is settled in the same process. `WorkspaceRegistry`
builds its canonical-cwd header index once, in `[Service.init]`, and
`attachSession` validates against that index (`readSessionHeader` prefers a live
Session, then the cached header, and only re-reads the store when neither
exists). The plugin therefore drops the moved session's stale index entry before
attaching — the fields are plain `Map`s on the service instance — so the next
validation re-reads the rewritten header from the store. That is the state a
restart would produce, without a restart. The Client then asks
`sessions.refreshProjections(id)` to rebuild the derived view, and any other
workspace that still lists the session is detached.

If the attach is still refused (for example while the session is open in a tab,
where a live Session still answers with the old header), the move is recorded as
pending and settles automatically on the next start.


### Workspace membership is verified, and repairable

`attachSession` is judged by the canonical-cwd index, which the harness builds at
startup. A session whose header was rewritten *during this run* may therefore be
rejected until the harness restarts. The Host never reports that as a plain
success:

- `moved` — header rewritten, read-back matched, workspace reported the session.
- `moved-unattached` — the file moved but the workspace did not accept it yet.
- `attached` — the session already lived in the target directory (an earlier
  move left the membership behind); this run only completed the membership.

Repeating the same move is the repair action: when the stored cwd already equals
the target, the plugin skips the file work and only settles the workspace
membership, so a partial move is finished by the same command that made it.
`workspace-unattached` means even that failed; restart DSH and repeat once the
index is fresh.

The unattached case also heals itself on startup: the Host records the pending
`(sessionId, target)` pair in `.remaker-pending.json`, and two seconds into the
next boot — after the registry has rebuilt its index — it settles the membership
and clears the entry. So a move that landed its file but not its membership needs
one restart, not a second click.

Both halves also refuse to break application start: a throwing Client factory
degrades to an absent plugin instead of failing the Web boot gate (which fails
the whole app with `1 entry did not activate`), and a throwing Host `apply` is
logged to `.workspace-manager.log` instead of failing the entry.

### The workspace title follows its directory, unless you renamed it

`create(path)` derives a title from the last path segment, so a title that still
equals its own basename was never typed by the user: a rebuild carries that kind
of title over to the new directory name (`ce` rebuilt onto
`D:\Github\workspace test` becomes `workspace test`). A title that differs from
its basename is treated as a deliberate rename and is preserved untouched.

Records created by an earlier build ignored that rule and kept the pre-rebuild
title. The workspace row in the manager offers a one-click repair for exactly
that shape — the button only appears when the stored title differs from the
folder name — and it calls `retitleWorkspace(workspaceId, title)`, which uses the
supported `Workspace#setTitle` and needs no restart.

## Install

```bash
plugin_manager install_bundle target=D:\Github\dsh-workspace-manager
```

Then verify the loader row exists:

```bash
cordis_inspect_query Config.listConfigs name=dsh-workspace-manager
```

Replacing an older install: `plugin_manager remove_bundle target=dsh-workspace-remaker`
drops the previous bundle and its sidebar entry.

### The panel reports the same activity the sidebar does

A workspace row says `N running` only when a session really is mid-turn, and it
gets that answer from the same two sources the shipped sidebar uses:

```js
useSessionStatus().get(sessionId)?.running ?? useSessions().byId[sessionId]?.running
```

A session the app merely keeps open is shown as `N open · idle`, its buttons stay
enabled, and the host releases it before touching any file. When neither source
knows the session, the panel falls back to the host's own summary instead of
inventing an answer.

## The panel

The panel is a card grid rather than a table: each workspace is an
`article.wsm-card` carrying a status dot, its name, the canvas path, activity
badges and four actions (rebuild / merge / rename / delete). Actions disable
themselves only while a session is *running* — a workspace that is merely open
still operates, because an idle holder is released before the move.

Styling rides on the host theme instead of hard-coded colours, so the panel
follows the Harness light/dark switch:

```css
.wsm-card {
  border: .5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-xl);
  background: var(--dsw-alias-settings-card-fill);
}
.wsm-card:hover { background: var(--dsw-alias-interactive-bg-hover); }
```

While the first read is in flight the grid shows three pulsing skeletons, so the
panel never flashes an empty state. `prefers-reduced-motion` turns the pulse off.

## Tests

```bash
node --test
```

The suite runs without the harness: `test/fakes.js` stands in for the storage,
the workspace registry, `sessionController` and the agent registry, publishing
real files into a throwaway `DSH_HOME`.

- `paths.test.js` — `samePath` / `titleFollowsPath` / `encodeId` edge cases.
- `move.test.js` — the whole move transaction: success, a held session, a turn in
  flight, an empty log, a failing publish, a successor that reads back short, a
  store that still lists the parked id, and the repair path when a move is
  repeated.
- `contract.test.js` — loads `client.js` in a `vm` and asserts the Client mounts
  exactly the descriptors the Host registers (ids, namespaces, parameter wires)
  and that both locale dictionaries carry the same keys.

## Notes and limits

- Moving a session does not move the files on disk. Only the session's recorded
  working directory changes.
- Nested workspaces are legal in current DSH builds, so nesting is not refused;
  only a target that cannot host a workspace (missing, not a directory, not
  writable) is.
- Sessions stored in an older format report `migration-required`; open them once
  so the harness upgrades them, then move them.
- A forked session keeps its `parentSession` link and its inherited event offset;
  the parent stays where it is, so move parents first if you want the whole tree
  in one directory.
- The move is refused while the session runs. Stop it, move it, re-open it.
- A session the app has open but idle used to be refused: the store keeps its write
  ownership, so no successor artifact can be published for it. The plugin now
  releases an idle holder first (`#releaseHeld` disposes the agent's own Cordis
  scope and re-reads the registry to confirm) and only refuses when the release
  did not happen. A session mid-turn is still refused: it has real work to finish.
- Every seat draws the same occupancy chips from `listWorkspaces`, so a blocked
  workspace is visible before a button is pressed.
- `删除 / Delete` removes the record only; the directory and its session files are
  left on disk, and the sessions are archived so they are easy to find again.
- The plugin never edits committed bytes: it publishes a successor through
  `sessionPersistence`, so the store's no-rewrite rule and framing checks stay
  intact.

## Verification

```bash
# 1. the loader row exists and the bundle applied
cordis_inspect_query Config.listConfigs name=dsh-workspace-manager
# 2. the Client half registered its three seats (live Slots tree)
cordis_inspect_query Slots.listSubTree root=sidebar.panellist
cordis_inspect_query Slots.listSubTree root=main
cordis_inspect_query Slots.listSubTree root=sidebar.workspaces.session.menu.item
```

`sidebar.panellist` and `main` both carry the id `workspace-manager`; the first is
the sidebar button, the second the panel it dispatches. The same panel is also
reachable from `settings.section` (id `workspace-manager-settings`).

Finished results retire on their own after a few seconds, so an operation that
succeeded cannot leave a banner sitting in the panel.

The offline checks (no harness needed) cover the refusal paths, `inspect`, and the
boot self-heal against a fake registry:

```bash
node .scratch/smoke.mjs
```

The same operation is reachable by the agent as the `workspace_manager` tool, so
the move can be exercised without the UI:

```
workspace_manager { "action": "inspect", "sessionId": "session-<uuid>" }
workspace_manager { "action": "move", "sessionId": "session-<uuid>", "target": "D:\\target" }
```

`action=listWorkspaces` reports every workspace with its real session count and
its blockers (`running` / `open`), which is the same data the panel draws its
occupancy chips from. `action=inspect` is read-only and reports the recorded
directory, the owning workspace, whether the session runs, and the storage format. `action=move`
performs the move. Every step appends a line to `.workspace-manager.log` next to this
package, which is the first place to look when a move refuses.

## The cached title follows the header

The Session list builds its projection column from
`sessionProjectionCache.cachedSnapshot(header)`, and that read only matches a
stored record whose lifecycle identity (`formatVersion`, `createdAt`, `cwd`,
`isSeeded`) equals the header it is handed. A move rewrites `cwd` in the header,
so the record written before the move stops matching and the sidebar renders the
row as “未命名” (unnamed) even though the cached title row is intact.

A move therefore ends with a cold projection read off the complete log
(`sessionProjectionCache.coldSnapshot(header, inheritedEventCount, events)`),
which folds the log against the new identity and writes a fresh checkpoint
back. `action=move` reports the outcome as `projections: { asOfSeq, keys }`, and
repeating a move to the directory a session already lives in re-runs only this
repair step.

## Reloading the plugin without restarting the harness

The host half is reloaded by toggling its entry through the plugin manager —
`plugin_manager` `set_plugin` with `target: "include:workspace-manager"`,
`enabled: false` then `enabled: true` — which re-imports `index.js` in place. The
client half is refreshed with the page. Neither needs a DSH restart.
