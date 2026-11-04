# dsh-workspace-control

DeepSeek Harness 工作区管理插件：重建、合并、重命名、删除工作区，迁移单个会话，并在面板里重启或热刷新 DSH。

会话的工作目录在创建时就写进了会话头和存储目录名，界面无法修改。本插件通过官方的 `sessionPersistence` 接口生成新的会话头，不直接改字节，存储的只追加约束和格式校验保持有效。

## 功能

| 功能 | 入口 | 说明 |
| --- | --- | --- |
| 重建工作区 | 面板「重建…」 | 整个工作区换到新目录，会话随之移动；旧记录清空后删除，标题跟随新目录名（手动改过的标题保留）。 |
| 合并工作区 | 面板「合并…」 | 把其他工作区的会话并入当前目录；源记录清空后删除。 |
| 重命名 | 面板「重命名」 | 只改侧栏标题，不动目录。 |
| 删除 | 面板「删除」 | 删除工作区记录；会话先归档，目录与文件留在磁盘，可再用同一路径加回。 |
| 移动会话 | 会话行「…」菜单 →「移动到工作区…」 | 把单个会话移到目标目录；目标不是工作区时自动创建。 |
| 重启 DSH | 面板「重启 DSH」 | 退出并重新启动 DSH，用于释放被应用占用的会话。 |
| 刷新界面 | 面板头部、重启面板、会话头部圆形按钮 | 热更新 Host 插件代码并重新发布界面，不重启 DSH。 |

## 工作区与会话

面板入口在侧栏面板行的「工作区管理」图标，设置页也有同一面板。

每一行在点击前就给出：目录路径、真实会话数、占用情况与原因。运行中的工作区禁用重建、合并、删除；被应用打开但空闲的会话会先被释放，释放失败才拒绝。

两个拒绝原因：

- `running`：回合正在执行。移动会让 agent 留在旧目录，必须先停止。
- `session-open` / `open`：会话日志仍被应用持有，存储拒绝发布后继。插件先尝试释放，做不到才拒绝。

移动保持会话 id、标题、全部已提交事件和格式版本，不直接编辑文件。若发布失败，已停放的原目录会回滚；中断的移动在下次启动时自动判定并恢复。重复执行同一移动即为修复动作，只会补齐工作区归属。

移动成功但工作区归属没有被接受时，结果为 `moved-unattached`，插件会写入 pending 队列，并在下次启动 2 秒后自动补上归属。

主要结果码：

| 结果 | 含义 |
| --- | --- |
| `moved` | 文件与工作区归属都已完成。 |
| `moved-unattached` | 文件已移动，归属待下次启动自动补齐。 |
| `attached` | 文件已在目标目录，本次只补了归属。 |
| `held-restart` | 会话被应用持有，需要重启 DSH 后再重试。 |
| `workspace-unattached` | 归属修复也失败，重启 DSH 后重试一次。 |
| `migration-required` | 会话是旧格式，先打开一次完成升级。 |

## 重启 DSH

面板的「重启 DSH」会先统计进行中的回合并确认，然后退出当前进程并重新启动。

- 桌面端通过 WMI 创建隐藏的 helper 进程（`Win32_ProcessStartup.ShowWindow = 0`），不产生终端窗口，点击到重新启动约 1.2 秒。
- 其他环境若没有可用的重启能力，返回 `restart-unsupported`，按钮禁用，不做猜测。

## 刷新界面

三个入口做同一件事：

1. 面板头部的「刷新界面」；
2. 重启面板里的同名按钮；
3. 会话头部工具行的圆形刷新按钮。

刷新分两半：Host 端通过官方 HMR 服务 `reconcileProfile` 重载改动的插件代码；随后重新发布所有本地 Client bundle，页面用 `modules.entries.sync` 原地热替换。进行中的回合不受影响，页面不重载，滚动位置和状态保留。

桌面端从不 reload 文档：桌面壳在窗口创建时冻结 boot manifest，reload 可能请求到跨代次的 bundle，一个入口失败就会中止整轮启动。热同步只重挂字节变化的 fiber，没有这个窗口。

刷新不显示 DSH 的启动 loading 页，因为根本没有文档重载。插件改为自己画一层半透明遮罩加 spinner，快速刷新时 120ms 后才淡入，`prefers-reduced-motion` 下禁用。

`retain.js` 会保留 boot 时的 bundle 代次，即使之后按 F5 或使用菜单里的「重新加载页面」，旧 URL 仍能取到字节，不会再因 404 导致启动失败。

清空场景下的结果：

- `refreshed-hot`：有插件被重载并完成热替换。
- `refreshed-unchanged`：没有改动，界面已是最新。
- `refreshed-needs-restart`：页面与 Host 不是同一代次，需要重启 DSH。
- `refreshed-partial` / `plugins-pending` / `plugins-restart`：部分插件没有回来。
- `no-hmr` / `reload-failed`：当前构建没有 HMR 服务，或 reconcile 抛错。

普通 `dsh web` 页面没有冻结的 manifest，仍走文档 reload。

## 安装

```bash
dsh plugin --profile web add dsh-workspace-control
```

从本地 checkout 安装：

```bash
plugin_manager install_bundle target=D:\path\to\dsh-workspace-control
```

旧版本以 `dsh-workspace-remaker`、`dsh-workspace-manager` 发布过，安装前先移除：

```bash
plugin_manager remove_bundle target=dsh-workspace-manager
```

## Agent 接口

`workspace_control` 工具提供全部操作，按钮只是它的界面包装。

| action | 作用 |
| --- | --- |
| `inspect` | 只读：会话记录的目录、所属工作区、是否运行、存储格式。 |
| `move` | 移动单个会话到 `target`。 |
| `listWorkspaces` | 列出全部工作区、真实会话数与阻塞原因。 |
| `rebuild` | 把工作区 `workspaceId` 重建到 `target`。 |
| `merge` | 把 `sourceIds` 合并进 `workspaceId`。 |
| `retitle` | 修改工作区标题。 |
| `remove` | 删除工作区记录，`keepSessions` 控制是否保留会话。 |
| `probeRestart` | 报告重启能力与待打断的回合。 |
| `restart` | 重启 DSH，`force` 允许打断进行中的回合。 |
| `refresh` | 热刷新，`mode` 为 `auto`、`plugins`、`interface`。 |
| `clientModule` | 报告 Client bundle 是否在当前页面的启动图中。 |

示例：

```text
workspace_control action=refresh mode=auto
workspace_control action=restart force=true
workspace_control action=inspect sessionId=session-<uuid>
workspace_control action=move sessionId=session-<uuid> target=D:\target
```

编辑插件后应调用 `action=refresh`，而不是重启 DSH。只有刷新明确报告需要重启，或改了插件清单与依赖时，才用 `action=restart`。

## 限制

- 移动会话不改磁盘文件，只改记录的工作目录。
- 运行中的会话不能移动，先停止再移动。
- fork 会话保留 `parentSession` 链接与继承偏移；要整理整棵树，先移动父会话。
- 旧格式会话先打开一次完成升级，再移动。
- 删除只删记录并归档会话，目录和会话文件不会删除。
- 嵌套工作区合法，只拒绝无法承载工作区的目标（不存在、不是目录、不可写）。

## 配置与日志

- `WSC_LOG=0`：关闭日志。
- 默认写 `.workspace-control.log`（512 KiB 轮转），pending 队列原子替换，崩溃不会留下半个队列。

## 开发

```bash
npm test
```

测试不需要启动 harness：`test/fakes.js` 提供存储、工作区注册表与 agent 注册表，真实写文件到临时 `DSH_HOME`。覆盖移动事务、拒绝路径、重启 helper 文本、刷新决策、boot bundle 保留，以及在 `vm` 中双重求值 `client.js` 时只注册一次。

`scripts/sync-contract.mjs` 校验 Client 侧描述符镜像与 `index.js` 一致，`npm run sync:contract` 重新生成。界面规范见 [docs/design-guidelines.md](docs/design-guidelines.md)。

## 链接

- 仓库：https://github.com/QIUZAIYOU/dsh-workspace-control
- 问题：https://github.com/QIUZAIYOU/dsh-workspace-control/issues
- 许可证：MIT
