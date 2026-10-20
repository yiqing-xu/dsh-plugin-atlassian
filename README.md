# dsh-plugin-atlassian

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**中文** · [English](README.en.md)

把 **Atlassian 官方远程 MCP 服务器**接入 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)。
一次浏览器授权后，Jira、Confluence、Bitbucket、Goals、Projects、Loom 等产品的工具会作为
原生工具出现在 agent 的工具列表里：

```
mcp__atlassian__getJiraIssue
mcp__atlassian__createJiraIssue
mcp__atlassian__searchConfluence
```

![设置 → Atlassian](assets/settings-page.png)

DSH 自带的 `dsh-mcp-client` 不支持 OAuth；改用 API token 则每次工具调用都要显式传 `cloudId`。
这个插件走 OAuth 2.1 补上这一段——站点由授权决定，不需要传 `cloudId`。

插件连的是 Atlassian MCP **v2**，并且**开两条连接**：

| 连接 | 端点 | 用途 | 是否注册给 agent |
|---|---|---|---|
| 模型连接 | `https://mcp.atlassian.com/v2/mcp` | v2 默认只下发少量 primary 工具加 `discover` / `executeRead` / `executeWrite` / `executeDestructive` | **是** |
| 看板连接 | `https://mcp.atlassian.com/v2/mcp?tools=all` | 平铺目录，看板按工具名直连（`listJiraProjects`、`getJiraBoardSprintData`…） | **否** |

这么分是因为 `?tools=all` 的平铺目录有两百多个工具定义，全部注册进 agent 会让**每一次请求**都先花掉
几万 token 的上下文。现在模型只看到 primary 那十来个，看板仍然能调用全部工具，两边共用同一份
OAuth 授权（同一个资源，只是查询参数不同）。

代价是：非 primary 的工具（`searchConfluence`、`listJiraIssueTransitions` 等）**模型不能直接按名字调用**，
要先 `discover` 再 `executeRead`/`executeWrite`。想要回到「全部注册」的老行为，把 `boardUrl` 设成和
`url` 一样、并给 `url` 带上 `?tools=all` 即可。

v2 是**独立的 OAuth 资源**：授权服务器是 `auth.atlassian.com/<id>`，v1 的 client 注册和 token
不能沿用。插件的授权文件按 URL 分文件保存，所以从 v1 升级后旧文件还在，但需要在设置页重新
**连接 Atlassian** 一次。授权文件的键从 `…?tools=all` 变成了 `…/v2/mcp`，所以从「单连接」版本升级
上来同样要重新授权一次。

## 兼容的 Harness 版本

目标运行环境是 **DeepSeek Harness 0.2.0-rc.2**。插件对 `@deepseek-ai/dsh-tools` 声明了一个
跨 0.1.x / 0.2.x 的 peer 区间；Harness 安装插件时会用 `includePrerelease` 校验 `@deepseek-ai/dsh-*`
的 peer，所以在 0.1.x 与 0.2.0-rc.2 上都能装上。

## 安装

```sh
dsh plugin --profile desktop add https://github.com/zhenyong97/dsh-plugin-atlassian/releases/latest/download/dsh-plugin-atlassian.tgz
```

装完**重启该 profile**。把 `desktop` 换成你实际使用的 profile 名。

这条装的是 Release 上的**预构建**包：`.tgz` 里已经带了编译好的 `lib/`，安装时不跑构建，也就不会
撞上 pnpm 默认拦截构建脚本那一步。要从源码装、自己编译，用仓库地址代替：

```sh
dsh plugin --profile desktop add github:zhenyong97/dsh-plugin-atlassian
```

（后者会跑 `prepare` 构建，pnpm 默认会拦下来，需要按它的提示把构建授权写进该 profile 的
`pnpm-workspace.yaml`。）

## 连接 Atlassian

1. 打开 **设置 → Atlassian**
2. 点 **连接 Atlassian**
3. 在 Atlassian 授权页**选择要授权的站点**并批准
4. 状态变为 **已连接**，设置页同时列出站点与可用工具数
5. 点 **查看工具** 展开「工具清单」，可搜索并逐个查看工具名称和 Atlassian 提供的说明
6. 之后随时可以点 **测试连接**，验证当前 token 是否仍然有效

![设置导航里的入口](assets/settings-nav.png)

本页开头那张设置页就是连上之后的样子：站点那一行是你在授权时选中的站点，工具数随授权站点开通的
产品而定。授权页没有自动打开时，设置页会显示一条可点击的授权链接。卡住就点 **断开连接** 再重连一次。

「工具清单」按需加载，不会拖慢每几秒一次的状态轮询；展开后可以按工具名或说明搜索。列表里的名字就是
agent 工具列表里的名字（`mcp__atlassian__...`），说明逐字来自 MCP 服务器，方便确认某个能力到底
存在、服务端自己是怎么描述它的。

页面下方的 **侧边栏入口** 开关控制侧边栏是否显示 Jira 图标。关掉后图标和它对应的看板面板一起
撤下，看板数据与 agent 工具都不受影响，随时可以再打开。选择存在 profile 的
`.dsh-atlassian/atlassian-prefs.json` 里，重启后仍然有效；**断开连接不会重置它**。

**测试连接** 不是读本地记录的过期时间，而是沿着现有 MCP 连接真的发起一次带鉴权的只读调用（优先
`getAccessibleAtlassianResources`，其次 `atlassianUserInfo`，都没有时退到 `tools/list`）。所以：

- 访问令牌过期、refresh token 还有效 → SDK 自动换新令牌，页面显示 **Token 已自动刷新**
- 两者都失效（401 / `invalid_grant`）→ 清掉本地 token、下线已注册的工具，并提示重新授权
- 网络故障或 Atlassian 5xx → 只报 **无法验证**，不会误清授权

连上之后，直接对 agent 说人话就行：

- 「列出 PROJ 项目里分配给我的、还没关闭的工单」
- 「把这段需求拆成 5 个子任务，挂到 PROJ-123 下面」
- 「把这次会议的结论写成 Confluence 页面，放到 Engineering 空间」
- 「搜一下 Confluence 里带 release-notes 标签的页面，汇总成本周发布说明」

## 操作方式

### 1. 打开 Jira 看板

授权完成后，侧边栏会多出一个 Jira 图标，点它打开看板。它拉的正是同一条 MCP 连接，所以不需要
额外的 token 或 cloudId 配置：

![Jira 看板](assets/jira-board.png)

- **按状态分列**。Jira 的每个状态就是一列，按状态类别（待办 → 进行中 → 完成）排序；同一类别
  内按名称排，所以刷新不会跳列。
- **项目行跟 Jira 侧边栏一样，只显示「最近 + 固定」**。站点上的项目动辄上百（这个站点是 148 个），
  平铺就是一面墙。所以行里只放：
  1. **固定项目**（你点圆点钉住的项目，按固定顺序）；
  2. **最近打开过的项目**（你在这块看板上选过的，最新的在最前，最多记 8 个）；
  3. **当前选中的项目**（哪怕它既没固定也不在最近里，也一定显示，因为刚选完就得能看见）。

  其余全部收进行尾的 **「更多项目 · N」** 选择器：点开可按项目键或名称搜索，并按站点自己的
  `lastIssueUpdateTime` 排序（最近有改动的在前），不用在一堆缩写里翻。项目**就是看板范围**，
  始终只读一个，所以芯片后面的数字是这个项目真实的工单数；没有「全部」这个选项。
  最近列表存在 profile 的 `.dsh-atlassian/atlassian-prefs.json` 里，重开页面仍在。
- **固定项目**。每个项目芯片右侧有一个固定按钮（空心圆 → 实心圆）——点它把该项目**追加**到项目行
  最前，多个项目按你点击的顺序依次排开，再点一次取消固定。固定只重排行、不隐藏、也不触发筛选。
- **按冲刺筛选**。冲刺是项目里可枚举的**具名选项**（例如「镇海炼化冲刺15.5」），不是「有没有冲刺」。
  冲刺行只有一个可搜索的具体冲刺选择器：它向服务端列出该项目所有面板上的冲刺（含已结束的——
  RD003 一个项目就有 160 个），按「进行中 → 未开始 → 已结束（新的在前）」排序，支持输入名称收窄。
  选中后写入 JQL（`sprint = <id>`）由服务端筛选，所以不在当前这一页的工单也能被正确筛出来；
  芯片上的 × 或「清除筛选」可复原。
- **按状态类别筛选**。待办 / 进行中 / 完成三个芯片同样带数量，与项目范围是「与」的关系。
- **经办人是我**。「经办人 → 我」这个开关把 `assignee = currentUser()` 折进 JQL，由服务端筛选——
  不是在本页里挑。看板每次会把当前项目的匹配工单**翻页取全**（单页 100 条，直到服务端说没了为止），
  所以「我」的数字和项目里有多少工单无关。开关不带数量：它改的是查询，一个真实的数字要再问一次
  服务端。
- **搜索框**在编号、标题、项目名里做子串匹配，纯客户端即时过滤，不产生请求。但看板只持有当前
  项目的工单，
  所以**输入 `HMHP-111` 这样的编号、或粘贴 Jira 链接后回车**，会改成按编号向服务端精确查找：
  不在当前这一页、也不在当前筛选里的工单同样能打开，接着就能在抽屉里看详情或交给 agent。查到的
  工单会临时作为一张卡片出现，不受项目/状态芯片影响；清空搜索框或按 `Esc` 即收起。
- **视图切换**。「进行中」排除已完成工单（默认，避免长 backlog 把在办的埋掉），「全部」含已完成。
- **JQL 直接显示并可编辑**，回车生效——JQL 就是看板的真实状态，藏起来会让"工单数不对"看起来像
  bug；改过之后会出现「重置」回到所选视图。
- 卡片左侧的状态色条、底部的项目芯片，以及标题栏的总数 / 待办 / 进行中统计，都是一眼扫读用的。
- **跟随主题**：文字、边框、卡片底色与状态色都取自 Harness 的主题变量，深色模式下不会出现
  「深底深字」；卡片悬停、滚动条和键盘焦点环也按当前主题绘制。
- 看板每 60 秒自己刷新一次，页面不可见时跳过；「刷新」会连项目列表一起重读（新建的项目不用重开
  页面就能选）。底部只在真的撞到安全上限时才提示。
- **项目范围写进 JQL**：看板显示的那行 JQL 会带上 `project = <KEY>`。你手工改成 `project in (A, B)`
  这类多项目查询时，项目芯片会停止声明某一个项目——查询才是真相。单项目形式（`project = A`）
  会被芯片覆盖。
- **打开不重新加载**。点进点出侧边栏图标、去一趟设置再回来，看到的是同一块看板：一分钟内的
  数据直接复用，更旧的先原样显示、再在后台静默刷新，只有第一次打开才需要等。视图和筛选条件也
  一起留着。**项目列表同样走缓存**——初始化读取一次后，一小时内重开面板不再请求 `/projects`，
  不会闪「读取项目…」；过期后先显示旧列表再后台刷新。后台刷新失败只在标题栏标一个「同步失败」，不会把已经能读的看板换成报错页；断开
  连接后缓存作废，回到「还没有连接」。
- **点标题就刷新**。左上角「Jira 看板」那一整块是个按钮：点它立即重新读取看板（工具条里的
  「刷新」是同一条路径），读取期间时间戳后面会出现「刷新中…」。所以「不再自动加载」不会让你
  失去手动刷新的地方。

### 2. 看图单详情，确认状态流转

**点任意卡片**，右侧打开抽屉：工单描述（Markdown 渲染）、优先级、负责人、项目，以及**服务端当前
提供的状态流转按钮**——按钮就是服务端返回的那几个，不会猜。抽屉头是吸顶的，长描述滚下去也够
得到按钮。

![卡片详情与状态流转](assets/board-detail.png)

状态变更由你在抽屉里点确认，agent 那边被明确要求不要自行改工单状态。

### 3. 把工单交给 agent

**右键任意卡片**打开菜单，就地选择投递目标：

![投递菜单](assets/board-handoff.png)

| 菜单项 | 行为 |
|---|---|
| **新建会话（当前工作区）** | 在当前/最近的工作区开新会话并投递 |
| **投到当前会话** | 排队投进已打开的那个会话，不打断它正在做的事 |
| **展开某个工作区 → ＋新建会话** | 在该工作区开新会话并投递 |
| **展开某个工作区 → 某个会话** | 投进那个已经存在的会话（进行中的排在前面） |
| **复制提示词** | 只复制到剪贴板，你自己决定贴到哪 |

投递后**停留在看板**，成功提示留在原地，你可以接着投下一批；目标会话在侧边栏一点就到。

指令模板来自 `board.promptTemplate`（`{{key}}` / `{{summary}}` 会被替换）。默认模板刻意写得有
约束：先读代码再动手、只改这个任务范围内、给出可复核证据，并且**明确要求 agent 不要自行变更
Jira 工单状态**——状态流转由你在看板上点确认。自定义模板是按单工单写的，批量投递时会每个工单
各生成一份。

### 4. 多选，一次投一批

`Shift+点击` 从上一张卡片开始选择区间（按你看到的左→右、上→下顺序）。一旦有选中，卡片上会出现
复选框，底部出现批量操作条：

![多选与批量操作条](assets/board-selection.png)

可以一次把多个工单投给同一个会话或新建一个会话——多个工单会合成**一条**提示词，而不是互相穿插
的几条。

卡片也可以拖到侧边栏的看板图标上：落下来会选中拖动的那些工单并打开同一个菜单，由你确认目标。

## 会用到哪些工具

授权成功后，`url`（默认端点）列出的 primary 工具会以 `mcp__atlassian__<名称>` 出现在 agent 的工具
列表里；`boardUrl`（平铺目录）里的全部工具只供看板调用，设置页的「工具清单」会把它们标成 **仅看板**。
两边实际可用的集合都取决于你在授权站点里有权限访问的产品：

| 工具 | 用途 | agent 可见 |
|---|---|---|
| `searchJiraIssuesUsingJql` | 用 JQL 搜索工单 | ✅ |
| `getJiraIssue` | 读取单个工单 | ✅ |
| `createJiraIssue` / `editJiraIssue` | 新建 / 编辑工单 | ✅ |
| `atlassianUserInfo` | 当前授权账号 | ✅ |
| `getAccessibleAtlassianResources` | 该授权可访问的站点 | ✅ |
| `discover` + `executeRead`/`executeWrite` | 调用下面这些非 primary 能力 | ✅ |
| `listJiraProjects` | 列出可见的 Jira 项目 | 仅看板 |
| `listJiraIssueTransitions` | 查看某个工单可用的状态流转 | 仅看板 |
| `getJiraBoardSprintData` | 冲刺目录与筛选（v2 没有 `listJiraBoards` / `listJiraBoardSprints`） | 仅看板 |
| `searchConfluence` / `getConfluenceContent` 等 | Confluence 读写 | 经 `discover` |

> 具体哪些名字算 primary 由 Atlassian 决定，会随站点权限变化；以设置页「工具清单」的实际标注为准。

## 配置

默认配置开箱可用，通常不需要改。要改就在你 profile 的 `cordis.patch.yml` 里按 `id: atlassian`
覆盖：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `serverName` | `atlassian` | 工具名前缀：`mcp__<serverName>__<tool>` |
| `url` | `https://mcp.atlassian.com/v2/mcp` | **模型**连接；默认端点只有 primary 工具，上下文最小 |
| `boardUrl` | `https://mcp.atlassian.com/v2/mcp?tools=all` | **看板**连接；平铺目录，不注册给 agent。设成与 `url` 相同即回到「全部注册」的老行为 |
| `redirectPort` | `3334` | OAuth 回调端口，尽量保持不变 |
| `expectedSite` | 空 | 填了会在授权后校验站点，不一致时提示 |
| `autoOpenBrowser` | `true` | 点「连接 Atlassian」时自动打开浏览器 |
| `board.jql` | 空 | 看板打开的默认 JQL，留空用内置的「进行中」视图（排除已完成） |
| `board.limit` | `5000` | **安全上限**，不是每页条数：看板会按 100 条一页把当前项目的匹配工单翻页取全，只有撞到这个上限才停，并在底部提示 |
| `board.timeoutMs` | `90000` | 单次看板读取的超时 |
| `board.promptTemplate` | 空 | 交付给 agent 的指令模板，留空用内置模板 |
| `board.sprintField` | 空 | 冲刺字段的 `customfield_*` id，留空自动探测（见下） |

> **冲刺字段**：Atlassian v2 只在你按 `customfield_*` **id** 请求时才返回自定义字段，按名字请求 `sprint`
> 会被静默丢弃——这正是「冲刺芯片全空」的根因。留空时插件先问 `getJiraIssueTypeMetaWithFields`，取
> 名字含「冲刺/Sprint」且类型为数组对象的那一个；问不到才退回约定值 `customfield_10020`。站点改过字段
> 或有多套冲刺字段时，在这里钉死 id。

其余字段与完整默认值见 `cordis.patch.yml`。

> ⚠️ 补丁是**整体替换**该行的 `config`，不是合并，所以覆盖时其余字段也要照抄。

## 卸载

```sh
dsh plugin --profile desktop remove dsh-plugin-atlassian
```

授权信息存在 `$DSH_HOME/.dsh-atlassian/`，一并删除即可。

## 常见问题

<details>
<summary>设置里没有 Atlassian 页</summary>

该 profile 没有 web server 服务，或插件未随 profile 重启而生效。查启动日志里 `atlassian:`
前缀的告警。
</details>

<details>
<summary>状态停在「需要授权」/ 浏览器没打开</summary>

点设置页里的授权链接直接访问。若 `redirectPort` 被占用，插件会自动退回临时端口并重新注册。
流程彻底卡住时点 **断开连接** 清掉 token 再重连。若授权页明确提示 redirect 不允许，需要站点管理员
在 Atlassian 的域设置里放行 `http://127.0.0.1:<redirectPort>/callback`（v2 可能启用 redirect
allowlist）。
</details>

<details>
<summary>从 v1 升级后停在「需要授权」</summary>

v2 是独立的 OAuth 资源，v1 的 client 注册和 token 不能沿用。插件按 URL 分文件保存授权，旧文件
不会被覆盖；在设置页点一次 **连接 Atlassian** 重新授权即可。
</details>

<details>
<summary>怎么确认 token 还有没有效</summary>

点 **测试连接**。它做一次真实的带鉴权调用，而不是读本地过期时间；只有服务端明确拒绝
（401 / `invalid_grant`）才会清掉授权并要求重连，网络故障或 5xx 只报「无法验证」。
</details>

<details>
<summary>连接成功但工具数为 0</summary>

服务端没有返回工具，通常是站点权限问题——确认授权时选中的站点里有你期望访问的产品。
</details>

<details>
<summary>提示站点不匹配</summary>

你配的 `expectedSite` 与实际授权站点不一致。工具仍可用，只是指向设置页显示的那个站点。
改掉 `expectedSite` 或重新授权即可。**这是提示，不是阻断。**
</details>

## 已知限制

- 只桥接工具，MCP 的 Resources 与 Prompts 暂不支持
- 图片结果渲染为占位文本
- 设置页的导航图标是就地补丁（DSH 没提供图标接口），匹配不上时保持默认齿轮
- 未对 `expectedSite` 不匹配做硬阻断
- 模型侧没有实现 v2 的 `discover` → `execute*` 编排：`discover` / `executeRead` / `executeWrite` /
  `executeDestructive` 作为普通工具交给模型，怎么串由模型自己决定。因此非 primary 能力必须经这三步，
  不能按名字直接调
- 看板连接失败时（端点变化、网络问题）不会拖垮 agent 的工具，但面板会退回模型连接的工具集，此时
  项目 / 冲刺 / 流转这些功能会不可用；日志里有一条 `board catalogue … is unavailable`
- JSM 工具在 v2 里只支持 API token 认证，本插件只走 OAuth，所以不会加载 JSM 工具

## 开发

```sh
npm install && npm run build   # tsc(host) + tsc(client) + 打包 client bundle
```

在独立 profile 上验证、四个回归脚本，以及 README / 市场截图的抓取流程，见 `dev/README.md`。

## License

MIT
