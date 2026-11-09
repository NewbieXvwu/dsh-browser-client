# DSH Browser Client — 用户指南

DSH Browser Client 是一个浏览器扩展 + DSH host 插件的组合，让你在任意网页右下角的浮窗里，通过自然语言让 DeepSeek Harness 理解并操作当前页面。

> 适用版本：**DSH 0.2.2**（client-connection 传输）。若使用 0.1.x，请用 0.1.x 分支的插件；0.2.2 已移除 `apiProxy`。

## 安装

### 1. 安装 host 插件（DSH 侧）

在 DSH profile 的 `cordis.patch.yml` 中插入（或直接使用项目自带的 `cordis.patch.yml`）：

```yaml
- insert:
    - id: dsh-browser-host
      name: 'dsh-browser-host'   # 或本地路径: '/path/to/dsh-browser-host/lib/index.js'
      config:
        extPrefix: /ext-api
        extEventsPath: /ext-events.mux
        persistToken: true
        tokenFile: $DSH_HOME/browser-client-token   # 默认
        extraOrigins: []          # 额外放行的 Origin（如本地调试页 http://127.0.0.1:8899）
        toolTimeoutMs: 60000
```

重启 DSH。启动日志会打印：

```
[dsh-browser-host] extension token: <32-hex-token>
[dsh-browser-host] registered tool page_snapshot
[dsh-browser-host] registered tool page_eval
... (9 个 page_* 工具)
```

Token 也会写入 `$DSH_HOME/browser-client-token`（0600 权限；`DSH_HOME` 未设置时回退到 `~/.dsh`）。

> 推荐安装方式（自动写入 profile 的 bundle 列表并安装依赖）：
> ```bash
> dsh plugin --profile web add file:/path/to/dsh-browser-client
> ```
> 之后在 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 中确认包含
> `dsh-browser-host`，重启 DSH 即可。

### 2. 安装浏览器扩展

1. 打开 Chrome/Edge → `chrome://extensions`
2. 打开"开发者模式"
3. 点"加载已解压的扩展程序"，选择目录：`dsh-browser-host/browser-ext/extension`
4. 扩展图标出现在工具栏。悬浮窗不再常驻页面元素，用 `⌘⇧K` / `Ctrl+Shift+K`、工具栏图标或右键菜单打开

## 首次配置

1. 右键工具栏图标 →「选项」（或 `chrome://extensions` → 扩展详情 →「扩展程序选项」）
2. 填：
   - **宿主地址**：`http://127.0.0.1:3080`（或你的 DSH 端口）
   - **访问令牌**：`browser-client-token` 文件内容（或启动日志里的 token）
3. 点「测试连接」，显示"连接正常"后保存
4. 可选：在「页面目录规则」里添加 `github.com/acme/* → /Users/me/work/acme`，命中规则的页面会自动绑定到该目录

## 悬浮窗

悬浮窗就是 DSH WebUI 本身：会话流、composer、工具卡片都来自宿主，扩展只提供 frame 和页面桥。
默认是**极简模式**：没有边框、没有背景，只显示模型最后的回复和输入框，其余元素（用户气泡、
过程节点、侧栏、顶栏、tab、右侧栏）全部隐藏，窗口高度随内容收缩，不会整块挡住页面。

| 操作 | 快捷键 |
| --- | --- |
| 打开悬浮窗 | `⌘⇧K` / `Ctrl+Shift+K`、工具栏图标、右键「打开 DSH」 |
| 关闭 | `Esc`、点击页面任意处、再按一次打开快捷键 |
| 极简 / 完整视图 | `⌘⇧E` / `Ctrl+Shift+E`（同一窗口内切换，不重载） |
| 用选中文字提问 | 选中文字 → 右键「用 DSH 询问」（文字自动填入输入框） |

文字颜色跟随所在页面的明暗自动切换（浅色页深字、深色页浅字）。需要会话列表、工作区和完整
会话头时用 `⌘⇧E` 或右键「打开完整视图」；也可以在扩展选项页把默认模式设为「完整视图」。
完整视图窄窗口下侧栏是抽屉，左上角按钮打开会话列表。

`page_navigate` 跳转、或用户自己在标签页里点了链接，原页面会卸载、浮窗随之消失；扩展会在新页面
加载完成后自动把浮窗重新打开，原来的会话还在。不要在这个瞬间重复按快捷键，等页面加载完成即可。

## 使用

### 让 LLM 理解当前页面

在浮窗输入框问：

```
这个页面现在显示什么？
```

LLM 会调用 `page_snapshot` 工具读取页面结构化快照（URL、标题、可见文本、可交互元素清单），然后总结给你。

### 读取页面深层数据

```
页面上有哪些商品？分别多少钱？
```

LLM 会用 `page_snapshot` 读取可见内容；如需页面内部数据（接口返回、框架状态），它会用 `page_eval` 执行 JS 精确提取。

### 操作页面

```
把第一个商品加入购物车
```

LLM 会用 `page_act`（点击坐标/选择器）、必要时 `page_navigate` / `page_wait`，操作后重新快照验证效果。

### 截图查看

```
截个图看看现在页面什么样
```

`page_screenshot` 让扩展截当前标签页，PNG 保存在宿主机器的 `$DSH_HOME/browser-screenshots/`
（通常是 `~/.dsh/browser-screenshots/`），工具结果返回该文件的绝对路径；模型读取该路径即可看图。
截的是用户正在看的真实标签页，所以页面上的登录态、弹窗、滚动位置都会原样出现。

## 页面工具一览

| 工具 | 作用 |
|---|---|
| `page_snapshot` | 当前页结构化视图：URL/标题/可见文本/交互元素（带坐标） |
| `page_eval` | 在页面 MAIN world 执行任意 JS，读内部数据 |
| `page_act` | 点击/输入/滚动/键盘/清除（坐标或选择器定位） |
| `page_navigate` | 跳转/后退/前进/刷新 |
| `page_wait` | 等待选择器出现/网络空闲/延时 |
| `page_screenshot` | 截图（视口/元素/整页），存 `$DSH_HOME/browser-screenshots/` 并返回路径 |
| `page_network` | 读取页面 fetch/XHR 请求（URL/方法/状态/响应体预览），理解页面数据流 |

> **命名说明**：工具名使用下划线（`page_snapshot`）而非点号（`page.snapshot`）——腾讯 intranet 网关拒绝含点号的工具名（`invalid_parameter_value`）。

## 安全

- Token 仅本机回环通信，权限 0600，不写日志
- 悬浮窗页面由宿主在 `/browser-ui/` 直出，带 token 才能打开；页面与 `/assets`、`/plugins` 同源
- 页面内容脚本只通过 `chrome.runtime.sendMessage` 与扩展后台通信，页面 JS 无法直接触达 DSH 会话
- 页面工具在目标标签页的 content script 内执行，扩展后台只做转发

## 故障排查

| 现象 | 原因/处理 |
|---|---|
| 悬浮窗提示"尚未配置访问令牌" | 打开扩展选项页填写 token，保存后重开浮窗 |
| 快捷键无反应 | 在该页面按一下 `⌘⇧K`；被 Chrome 占用的页面（`chrome://`、扩展商店）请改用工具栏图标 |
| 工具栏图标点击无效 / 打开独立窗口 | 当前页面不能注入 content script（`chrome://`、应用商店等），会自动以独立窗口打开同一页面 |
| 页面工具超时 | 悬浮窗必须保持打开——工具请求经 `assets/control.js` 的 control 连接转发 |
| content script 未响应 | 页面加载后未刷新；刷新页面重试 |
| 工具调用报网关错误 | 确认工具名无点号；检查 DSH 日志与腾讯网关日志（`$DSH_HOME/logs/tencent-intranet/`） |
