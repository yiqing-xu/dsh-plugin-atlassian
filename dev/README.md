# 在独立 profile 上验证本插件

**不要拿正在用的 `desktop` profile 做实验。** 下面的步骤会建一个完全独立的
`atlassian-dev` profile，插件写崩了直接删目录重来，不影响日常使用。

## 一次性准备

```powershell
$dev = "$env:USERPROFILE\.dsh\profiles\atlassian-dev"
New-Item -ItemType Directory -Force -Path "$dev\node_modules" | Out-Null
```

`package.json`（profile 的 bundle 清单）：

```json
{
  "name": "dsh-profile-atlassian-dev",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-plugin-atlassian"
      ],
      "patchReload": "live"
    }
  }
}
```

`cordis.yml` 写 `[]`（组合树由各 bundle 的补丁层叠加而成）。

把本仓库链进这个 profile 的 `node_modules`。镜像里的 profile 就是用 Junction
把依赖接进 app 安装目录的，这里沿用同一机制，因此不需要真的跑一次 pnpm 安装
（把 `<本仓库绝对路径>` 换成你 clone 下来的位置，例如 `C:\src\jira-plugins`）：

```powershell
New-Item -ItemType Junction `
  -Path "$dev\node_modules\dsh-plugin-atlassian" `
  -Target "<本仓库绝对路径>"
```

验证解析：

```powershell
node -e "console.log(require.resolve('dsh-plugin-atlassian/package.json', {paths:[process.env.USERPROFILE + '/.dsh/profiles/atlassian-dev']}))"
```

## 每次改完代码

```powershell
npm run build
```

bundle 层的包元数据在进程内缓存，所以**改了 `package.json` / `cordis.patch.yml`
必须重启**；只改 `lib/*.js` 的话，重启也一样最省事。

## 看组合树（离线，不启动）

```powershell
dsh --profile atlassian-dev --dump-config
```

输出里应出现：

```yaml
# == dsh-plugin-atlassian
- id: atlassian
  name: dsh-plugin-atlassian
  config:
    serverName: atlassian
    ...
```

## 真正启动

```powershell
dsh --profile atlassian-dev --patch ./dev/overlay-no-browser.yml --port 43199 --no-open
```

`overlay-no-browser.yml` 把 `autoOpenBrowser` 关掉，避免每次启动都弹浏览器。
要测真实的浏览器授权流程，就去掉 `--patch`。

## 探接口

```powershell
curl http://127.0.0.1:43199/plugins/atlassian/status
curl -X POST http://127.0.0.1:43199/plugins/atlassian/connect
curl -X POST http://127.0.0.1:43199/plugins/atlassian/disconnect
```

看板相关的端点（同样要先换到登录 cookie）：

```powershell
curl http://127.0.0.1:43199/plugins/atlassian/debug-tools
curl http://127.0.0.1:43199/plugins/atlassian/board
curl "http://127.0.0.1:43199/plugins/atlassian/board?jql=project%20%3D%20DEMO"
curl http://127.0.0.1:43199/plugins/atlassian/projects
curl http://127.0.0.1:43199/plugins/atlassian/issue/DEMO-27
curl http://127.0.0.1:43199/plugins/atlassian/issue/DEMO-27/transitions
```

这些路由受 `connection` 的请求围栏保护，没带登录 cookie 会直接 401。把启动时打印的
`http://127.0.0.1:43199/?token=...` 用浏览器打开一次拿到 cookie，再用同一个会话 curl 即可。

`debug-tools` 返回这条连接发现的**原始 MCP 工具名**。看板是按工具名的片段匹配的，
当 `/board` 报「没有提供匹配 …的工具」时，先看这个列表：它区分「服务端改名了」和
「授权里根本没有 Jira 产品」。

`status` 里出现带真实 `client_id` 的 `authorizationUrl`，就说明动态客户端注册、
PKCE、loopback 回调端口全部就绪——剩下的只有浏览器里点批准那一下。

## 不启动进程的回归脚本

两个 harness 直接跑**编译产物**，不需要授权也不需要浏览器：

```powershell
npm run build
node dev/verify-board.mjs          # lib/board.js：字段映射、JQL 回退、流转、错误路径
node dev/verify-client-bundle.mjs  # lib/client.js：槽位注册契约与样式声明
```

`verify-board.mjs` 喂进去的是**真实站点抓下来的 MCP 返回**——站点、工单号与项目名换成了示例值，
字段结构一个没动——所以它覆盖的是解析与映射；唯一覆盖不到的是 `tools/call` 传输本身（那条路径由
正常会话里的工具调用覆盖）。

`verify-client-bundle.mjs` 用 `window.__ModuleLoader__` 和 `document` 的桩来物化 bundle，
断言它注册了 `settings.section`、`sidebar.panellist`、`main`，并且**侧边栏 id 与 main 的 key
一致**——这两个不一致时，图标会变成一个点不动的死按钮。它还断言**投递走的是 Session 对象**
（`binding()` / `using()`），不是 scoped ctx 的 `remote`：`scope(id)` 拿到的是一个没声明
`inject` 的空 fiber，Cordis 对这类 ctx 会拒绝对服务的**属性访问**
（`cannot get property "remote" without inject`），而 `using()` 是 0.2.0 里
"按需把没上场的会话物化出来"的唯一入口（0.1.x 的 `binding()` 自己会 `resolve()`，
0.2.0 不会）。

## 浏览器里的真实渲染

上面两个脚本都回答不了"页面到底长什么样"。这两个探针驱动真实 Chrome（走 CDP，无自动化依赖）
打开页面并断言 DOM：

```powershell
node dev/ui-probe.mjs    "http://127.0.0.1:43199/?token=..."                # 设置 → Atlassian
node dev/board-probe.mjs "http://127.0.0.1:43199/?token=..." --shot assets/probe-check.png
```

`board-probe.mjs` 点侧边栏的 Jira 图标，断言面板挂载、卡片渲染、抽屉里的流转按钮和三个交付按钮
都在，并且**不点击真正的流转**——那是你的线上工单，写操作只由 `verify-board.mjs` 对着假服务端
覆盖。

`--shot` 产出的是**未打码**的诊断图，给自己看用；README 与市场要用的图必须走下面的
`capture-screenshots.mjs`，它会先打码再拍。另外 `board-probe.mjs` 会**真的投递一次**（它要验证
投递链路），所以跑它之前先在 overlay 里把 `board.promptTemplate` 换成惰性模板，否则它会在你的
工作区里建一个会话并让 agent 真的开工。

两个探针共用 `dev/cdp.mjs` 里的驱动，所以行为不会各自漂移。

## 抓 README / 市场要用的截图

```powershell
dsh --profile atlassian-dev --patch ./dev/overlay-capture.yml --port 43199 --no-open
node dev/capture-screenshots.mjs "http://127.0.0.1:43199/?token=..."
```

一条命令抓齐 `screenshots.json` 里列的那几张：看板、卡片抽屉、多选条、投递菜单、设置页、设置导航。
它和两个探针共用 `dev/cdp.mjs`，所以截图与断言不会各说各话。**改 `screenshots.json` 时记得同步改
脚本里的文件名**，两处是同一份清单。

脚本要求 profile **已连接**：没授权时它照样跑得完，但看板是空的（「0 个工单」）、设置页写着
「需要授权」——那正是市场会展示出去的东西，所以脚本把这种情况算作抓取失败，而不是悄悄写一张空图。

**每次快门之前会自动打码。** 一张截图里同时有你的 Jira 和你的桌面：工单编号、工单正文、站点
主机名、项目芯片、JQL，以及侧边栏里你**其它**工作区和会话的名字，全都属于不该发布的东西。
`REDACT` 那组规则在拍照前把它们模糊掉，然后**回头再扫一遍**——任何仍露在模糊之外的匹配都会让这次
抓取直接失败，而不是写出一张带泄露的图。

规则只认结构和通用形状（`ABC-123` 这种编号、`*.atlassian.net`、项目芯片、「卡片编号所在的那个
元素」），**不认任何字面量**。这个文件是公开的：一条写出自己隐藏了什么的规则，泄露的正是它要隐藏
的东西。识别不出来的内容，就不该出现在截图里。日志同理——投递菜单展开的工作区只报会话条数，
不报名字。

`overlay-capture.yml` 与 `overlay-no-browser.yml` 的差别只有 `redirectPort: 3340`（和日常 profile
占着的 3334 分开），以及 `board.jql` 留空。想让每次抓出来的看板一模一样，就在 overlay 里钉住自己的
项目——但那份 overlay 要是也会提交，钉进去的 key 就成了公开仓库里的一个真实 key。

dev profile 的授权是独立的（`serverName: atlassian-dev`），得自己有一份，否则第一张图就是「需要
授权」。最快的办法是从一份已授权的会话文件复制一份：

```powershell
$dir = "$env:DSH_HOME\.dsh-atlassian"
$prod = Get-ChildItem $dir -Filter 'atlassian-*.json' |
  Where-Object { $_.Name -notlike 'atlassian-dev-*' } | Select-Object -First 1
Copy-Item $prod.FullName (Join-Path $dir ($prod.Name -replace '^atlassian-', 'atlassian-dev-')) -Force
```

⚠️ 复制前先看副本里有没有 `redirectUri`：`bridge.ts` 一旦发现它和本次绑定的端口不一致，就会
**丢掉客户端注册和 token**（换端口后注册本来就失效，留着只会在跳转时报一个看不懂的错）。生产
registration 绑的是 3334，所以「副本带 `redirectUri` + overlay 用 3340」这个组合会把刚复制来的
授权当场清掉，第一张图又变回「需要授权」。要么两边端口一致，要么用一个没有该字段的副本。

## 授权状态存在哪里（重要）

插件按 `(serverName, url)` 存一份会话文件：

```
$DSH_HOME/.dsh-atlassian/<serverName>-<url 的 sha256 前 12 位>.json
```

`overlay-no-browser.yml` 因此把 `serverName` 设成 **`atlassian-dev`**，而不是 `atlassian`。
用生产名跑 dev profile 会**加载你正在用的那份授权**；一旦 access token 过期、refresh 失败，
OAuth 客户端会清掉文件里的 `tokens` 字段，你的正式 profile 就得重新授权一次
（`clientInformation` 会保留，所以只是点一下「连接 Atlassian」，不用重新注册）。
换个名字就得到独立的 store 文件，互不影响。

清空 dev 的授权状态：

```powershell
Remove-Item "$env:USERPROFILE\.dsh\.dsh-atlassian\atlassian-dev-*.json"
```

> 别去删 `atlassian-*.json`——那是你日常 profile 的授权。
