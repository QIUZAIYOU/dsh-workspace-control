# dsh-workspace-control

DeepSeek Harness 的工作区管理插件。侧栏面板里可以重建、合并、重命名、删除工作区，把会话移到别的目录，也能重启 DSH 或刷新界面。

会话的工作目录在创建时写入会话头和存储目录名，界面改不了。插件通过官方 `sessionPersistence` 接口生成新的会话头，不直接改存储字节，只追加约束和格式校验依然生效。

## 功能

| 能力 | 说明 |
| --- | --- |
| 工作区列表 | 显示每个工作区的真实会话数、占用情况和目录路径。 |
| 重建 | 新目录接管旧工作区的会话；`--discard-sessions` 丢弃回退会话，`--run` 顺带重建。 |
| 合并 | 把选中的工作区折进第一个，会话并到它的目录；`--discard-sessions` 丢弃回退会话。 |
| 重命名 | 改全局标题，目录和 id 不变。 |
| 删除 | 只删工作区记录，会话归档保留；`--keep-sessions` 保留不归档。 |
| 移动会话 | 把单个会话迁到另一工作区，文件、工作区归属和缓存标题一起更新。 |
| 重启 | 拉起新的 DSH 进程。 |
| 刷新 | 重载插件代码和界面。 |

## 工作区与会话

侧栏面板行的「工作区管理」图标是入口；设置 → 工作区管理里直接显示同一个管理页，不用再点一次「打开」。

每一行在操作前给出目录路径、真实会话数、占用情况和原因。运行中的工作区不能重建、合并、删除；被应用打开但空闲的会话会先尝试释放，释放不了才拒绝。

两个常见拒绝原因：

- `running`：回合正在执行。移动会让 agent 留在旧目录，先停止它。
- `session-open` / `open`：会话日志仍被应用持有，存储拒绝发布后继。插件先释放，做不到才拒绝。

移动是一个事务：先把原会话目录暂时移开，在目标目录用 `sessionPersistence` 生成后继，读回校验，再删除临时副本；任何一步失败都会回滚。会话 id、标题、全部已提交事件和格式版本保持不变。

移动成功但工作区归属没被接受时，结果 `moved-unattached` 会进入 pending 队列，下次启动 2 秒后补归属。重复执行同一移动就是修复动作，只会补齐工作区归属。

| 结果码 | 含义 |
| --- | --- |
| `moved` | 文件已迁移，工作区归属已更新。 |
| `attached` | 会话原来就在目标目录，只补了工作区归属。 |
| `attached-unreprojected` | 归属已补，工作区清单没刷新；刷新界面或重启后可见。 |
| `moved-unverified` | 写入后读回校验不通过；重试或检查目标目录。 |
| `moved-unattached` | 文件已迁移，工作区注册表没接受；进 pending 队列，下次启动补归属。 |
| `moved-unreprojected` | 文件已迁移并登记，工作区清单没刷新；刷新界面或重启后可见。 |
| `held-restart` | 会话被持有（旧版本或日志仍被占用），重启 DSH 后重试。 |
| `workspace-unattached` | 记录已存储，工作区注册表没接受；重启 DSH 后重复一次。 |
| `migration-required` | 会话还是旧格式，先在旧版本 DSH 里打开一次再迁移。 |

## 重启 DSH

重启会加载插件改动、重载会话和工作区并刷新界面。桌面壳按当前平台拉起新进程；重启脚本失败时退回 `npm start`。

会先确认会话与工作区模型可用，有活跃回合时拒绝。想强制重启，先在面板里停止回合。返回的状态会说明新进程是已提交还是仍在等待。

重启后再点一次刷新，让新进程发布客户端 bundle。

## 刷新界面

有三个入口：面板头部、重启面板、会话头部。三者都会重载页面。

页面整体重载：侧栏、面板、对话框和 React 状态回到初始值；进行中的回合不受影响。

一次刷新做三件事：

1. Host 通过官方 HMR `reconcileProfile` 重载改动的插件代码，重新发布本地 Client bundle。
2. 页面把当前 boot manifest 上报 Host（`pinBoot`），Host 保留这一代 bundle。
3. Host 确认清单可以完整服务后，页面调用 `location.reload()`；新页面再同步最新 bundle。

桌面壳在窗口创建时冻结 boot manifest，不能直接重载。Host 不能保证旧清单可用时（刚升级、页面没上报、Host 重启过），刷新退回原地热同步，返回结果里写明原因，并提示重启一次 DSH。

从 0.8.3 或更早版本升级上来，先重启一次 DSH：`pinBoot` 是 Host 接口，旧进程没有。重启前点刷新会安全退回热同步。

刷新期间显示「正在刷新页面…」遮罩，120ms 后淡入；`prefers-reduced-motion` 下直接出现。它只覆盖重载前的空档，和 DSH 的启动 loading 页无关。

`retain.js` 保留 boot 代次的 bundle，之后按 F5 或用菜单「重新加载页面」还能取到字节。

Host 说不能重载时，刷新原地重载插件并重新发布 bundle，返回以下原因之一：

- `no-boot`：页面没上报 boot manifest。
- `pin-boot-unsupported`：Host 不认识 `pinBoot`。
- `pin-rejected`：Host 没保留这份清单。
- `reconcile-failed`：重载 Host 插件失败；bundle 已重新发布，状态可能仍是旧的。
- `not-live`：页面重载后没能从 Host 取到运行中的 bundle；强制重载。

普通 `dsh web` 页面没有冻结的 manifest，刷新总是重载文档。

界面按钮会重载页面；Agent 调 `workspace_control` 的 `action=refresh` 只重载 Host 并重新发布界面，不重载页面。

## 安装

```
dsh plugin --profile web add dsh-workspace-control
```

插件界面由 `cordis.patch.yml` 声明；安装后在设置 → 插件里启用。升级已有版本用：

```
dsh plugin --profile web update dsh-workspace-control
```

## Agent 接口

| action | 参数 | 说明 |
| --- | --- | --- |
| `inspect` | `sessionId` | 查看一个会话是否被持有，以及它所在的目录。 |
| `move` | `sessionId`、`target` | 把会话移到 `target` 工作区。 |
| `listWorkspaces` | 无 | 列出工作区、会话数和占用情况。 |
| `rebuild` | `workspaceId`、`target` | 用 `target` 目录重建工作区。 |
| `merge` | `workspaceId`、`sourceIds` | 把 `sourceIds` 合并进 `workspaceId`。 |
| `retitle` | `workspaceId`、`title` | 改工作区标题。 |
| `remove` | `workspaceId`、`keepSessions` | 删除工作区记录；默认先归档会话。 |
| `probeAgent` | `workspaceId` | 诊断：描述工作区里 DSH 实际持有的 agent 对象。 |
| `release` | `sessionId` | 诊断：释放一个空闲被持有的会话。 |
| `probeRestart` | 无 | 报告能否重启，以及会走哪条路径。 |
| `restart` | `force` | 重启 DSH；`force` 会打断正在执行的回合。 |
| `refresh` | `mode` | 重载插件代码并重新发布界面；`mode` 取 `auto`、`plugins` 或 `interface`。 |
| `clientModule` | 无 | 查 Client bundle 是否在 Web boot 图里。 |

`move`、`restart`、`refresh`、`rebuild`、`merge` 是写操作；`probeAgent`、`release` 只做诊断，不清理会话。

## 限制

- 移动通过 `sessionPersistence` 重写会话头并迁移会话目录，不直接编辑存储字节。
- 进行中的会话不能移动或删除；先停止回合。
- 工作区的文件系统变化（手动增删目录、重命名）不会被检测成工作区变更。
- 子会话和会话组跟随所属工作区；重建或删除时不能单独移动。
- 旧格式会话迁移前，先在旧版本 DSH 里打开一次。
- 嵌套工作区只检查路径前缀。删掉外层会让内层记录悬空。
- 删除命令只作用于工作区记录，不会删磁盘上的会话文件。

## 配置与日志

调试日志默认写到 `.scratch/workspace-control.log`；`WSM_LOG=debug` 调高级别。它记录移动、拒绝和补归属的结果。

用户级安装时默认在 `~/.dsh/logs/wsm.log`；`DSH_LOG_DIR` 或 `WSM_LOG_FILE` 可改位置。

重启 helper 走 `scripts/restart.mjs`；它会读 `DSH_WORKSPACE` 定位工作区。

## 开发

本仓库用纯 JS，无构建步骤。门禁：

```
npm test            # 契约镜像 + 单元测试
node --test         # 只跑单元测试；需要 node:test 和 vm
```

测试覆盖移动事务、拒绝路径、重启 helper 文本、刷新决策、boot bundle 保留，以及在 `vm` 中双重求值 `client.js` 时只注册一次。改完代码用 `npm run sync-contract` 同步契约，再跑 `npm test`。

面板样式见 [docs/design-guidelines.md](docs/design-guidelines.md)。

## 链接

- 仓库：<https://github.com/QIUZAIYOU/dsh-workspace-control>
- npm：<https://www.npmjs.com/package/dsh-workspace-control>
- 问题反馈：<https://github.com/QIUZAIYOU/dsh-workspace-control/issues>
