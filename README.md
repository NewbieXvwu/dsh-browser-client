# DSH Browser Client

让 LLM 通过浏览器浮窗会话，理解并操作用户当前浏览的任意页面。

**核心能力**：在任意网页右下角浮窗中运行 DSH 会话 —— LLM 通过 `page_*` 工具读取页面快照、执行 JS、点击/输入/滚动、截图，操作的是**用户已登录的真实浏览器**（cookie/SSO/内网权限天然现成）。

```
┌─ 浏览器 ──────────────────────────────────────────────┐
│ content script（launcher + 浮窗 frame + 页面桥）         │
│   ↕ postMessage / chrome.runtime                       │
│ 浮窗 = 宿主直出的真实 DSH WebUI（/browser-ui/）          │
│   ↕ /ext-api RPC + /ext-api-control + /browser-ui-mux   │
├─ DSH Host ─────────────────────────────────────────────┤
│ dsh-browser-host 插件                                  │
│  · /browser-ui/ 用 readResource 取官方 index 并注入 shim │
│  · /browser-ui-mux 代理宿主 /api/remote.mux（cookie 换取）│
│  · /ext-api RPC 代理（复用官方 client-connection 通道）  │
│  · /ext-api-control 双向通道（工具请求↔回包）             │
│  · lib/client.js（客户端插件：页面目录→工作区绑定）        │
│  · page_* 工具注册（harness → tools.register）           │
└───────────────────────────────────────────────────────┘
```

## 结构

```
lib/
  index.js      # 插件入口：路由/WS/工具注册
  ui-page.js    # /browser-ui/：读出官方 index 并注入 transport/embed
  mux-proxy.js  # /browser-ui-mux：换 cookie 后代理宿主 /api/remote.mux
  client.js     # 客户端插件：页面目录 → 工作区绑定、busy 状态
  bridge.js     # 双向通道：工具请求挂起/回包路由/超时/断连
  tools.js      # 9 个 page_* 工具定义（中继到扩展执行）
  upstream.js   # 扩展 RPC 方言 → DSH 0.2.2 client-connection 方言
assets/
  transport.js  # 页面内的传输钩子：api/* → /ext-api，mux → 代理端点
  control.js    # 页面内的 control 通道（工具请求 → 父页 → 扩展）
  embed.css     # 只隐藏完整版导航，不改任何上游组件
browser-ext/extension/
  manifest.json # MV3 扩展（storage/activeTab/scripting/tabs）
  content/content.js     # 中性 launcher + 浮窗 frame + 页面桥
  content/page-tools.js  # 页面执行核心（snapshot/eval/act/...）
  background/background.js # 配置 + URL→目录映射 + 截图 + 工具转发
  options/               # 连接设置与目录规则
docs/
  BUSINESS_PLAN.md  # 完整商用方案
  USER_GUIDE.md     # 安装/使用/故障排查
test/
  bridge-unit-test.mjs    # 通道生命周期单测（通过）
  extension-flow-test.mjs # 0.2.2 适配回归（扩展方言 → host → DSH）
  e2e-page-tool.mjs       # 全链路 E2E（LLM→工具→通道→扩展→回包→回答）
```

## 页面工具

| 工具 | 作用 |
|---|---|
| `page_snapshot` | 页面结构化快照（URL/标题/可见文本/交互元素+坐标） |
| `page_eval` | 页面 MAIN world 执行任意 JS 读数据 |
| `page_act` | 点击/输入/滚动/键盘/清除（坐标或选择器） |
| `page_navigate` | 跳转/后退/前进/刷新 |
| `page_wait` | 等待选择器/网络空闲/延时 |
| `page_screenshot` | 截图（视口/元素/整页） |
| `page_network` | 读取页面 fetch/XHR 请求（URL/方法/状态/响应体预览） |

> ⚠ **工具名用下划线不用点号**（`page_snapshot` 而非 `page.snapshot`）：腾讯 intranet 网关拒绝含点号的工具名。详见 `docs/BUSINESS_PLAN.md` 的踩坑记录。

## 快速开始

1. **Host 插件**：把 `cordis.patch.yml` 插入 DSH profile，重启 DSH。启动日志打印 token 并注册 9 个 `page_*` 工具。
2. **扩展**：Chrome → `chrome://extensions` → 开发者模式 → 加载已解压 → 选 `browser-ext/extension`。
3. **配置**：扩展详情 → 扩展程序选项（或右键图标 → 选项）填 Host 地址 + token（`$DSH_HOME/browser-client-token`），点"测试连接"。
4. **使用**：点页面右下角的圆形按钮打开悬浮窗（就是 DSH WebUI，已去掉完整版导航）；悬浮窗里问"这个页面现在显示什么？" → LLM 调 `page_snapshot` 回答。

详见 [docs/USER_GUIDE.md](docs/USER_GUIDE.md)。

## 测试

### 兼容性

- 目标运行时：**DSH 0.2.2**（`@deepseek-ai/cordis ^4.1` + client-connection 传输）。
- 0.1.x 的 `apiProxy` 服务已被移除：`/ext-api` 现在通过官方
  `connection.createSharedFetchHandler('/api')` + owner Peer 转发，事件流改为订阅
  Cordis `session/event`（见 `lib/index.js`、`lib/upstream.js`）。
- 0.2.2 不再向 Cordis 推送 assistant 流式增量，回复在 `assistant/message` 落盘后整段显示。

```bash
# 1. 通道单元测试（不需要 DSH 进程）
node test/bridge-unit-test.mjs

# 2. 适配回归（需要：boot 的隔离实例；不需要 LLM key）
./test/verify-boot.sh 4101
DSH_BASE=http://127.0.0.1:4101 TOKEN_FILE=test/env/browser-client-token-4101 \
  node test/extension-flow-test.mjs

# 3. 悬浮窗（真实 WebUI）端到端，不需要 LLM key
#    页面 boot → /ext-api RPC → mux WebSocket → 绑定目录 → 提问回显
DSH_BASE=http://127.0.0.1:4101 TOKEN_FILE=test/env/browser-client-token-4101 \
  node test/embed-test.mjs

# 4. 全链路 E2E（需要：DSH 测试实例 + LLM key）
node test/e2e-page-tool.mjs
node test/e2e-page-network.mjs

# 5. 真实浏览器 E2E（需要：加载扩展的浏览器 + DSH 实例 + LLM key）
node test/live-e2e-real.mjs
```

## 实机验证记录

在 360Chrome（Chromium 132）加载扩展 + DSH host（:3999）实测通过（0.1.x）：

- 页面右下角浮窗注入（Shadow DOM）✅
- 面板连接 host、绑定工作区、加载会话列表 ✅
- **真实链路**：面板提问 → LLM 调用 `page_snapshot` → 控制通道 → 面板 → content script → 读取真实页面 DOM（"机械键盘 ¥299 / 降噪耳机 ¥899 / 4K 显示器 ¥1999"）→ 回传 → LLM 完整作答 ✅

> ⚠ Chrome 151+ 在 macOS 上禁用了 `--load-extension` 命令行加载；实测 360Chrome 支持。Chrome 用户需通过 chrome://extensions 开发者模式手动加载。

**DSH 0.2.2 适配验证（2026-11）**：隔离实例（`./test/verify-boot.sh 4130`，DSH_HOME 独立）上
`extension-flow-test`、`workflow-store-test`、`workflow-executor-test`、`control-channel-smoke` 全部通过；
工作流经 storageDomain 落盘并跨重启保留。因环境没有 `DEEPSEEK_API_KEY`，未验证真实模型回复。

**悬浮窗重构（2026-11，插件 0.3.0 / 扩展 0.2.0）**：悬浮窗不再自带聊天 UI，而是由宿主插件在
`/browser-ui/` 直出真实 DSH WebUI（`webServer.readResource` + owner peer 取官方 index，
注入 transport shim 与只做隐藏的 `embed.css`），页面经 `/browser-ui-mux` 代理宿主
`/api/remote.mux`，RPC 走 `/ext-api`。`test/embed-test.mjs` 在隔离实例上验证：
真实 WebUI 启动、transport 生效、RPC 成功、mux 建连、目录绑定出工作区与会话、提问回显、
无 console 错误（520×760 抽屉布局截图核对）。

### 悬浮窗结构

- 页面：`${baseUrl}/browser-ui/?token=…` —— 官方 index，去掉完整版导航（顶栏/tab/图标栏/全局面板/设置），
  保留会话流、composer、会话侧栏（窄窗为抽屉，左上角按钮打开）。
- 传输：`assets/transport.js` 把 `api/<endpoint>` 改写为 `/ext-api/<endpoint>`（Bearer token），
  `remote.mux` WebSocket 改写为 `/browser-ui-mux`；宿主侧换 operator cookie 后连接官方 mux。
- 绑定：`lib/client.js`（客户端插件）监听父页 `dsh:page-url`，用公开 RPC 创建工作区并打开其会话。
- 工具：`assets/control.js` 在页面内持有 `/ext-api-control`；工具请求经 content script →
  background → 当前标签页 `page-tools.js` 执行后原路返回。

## 状态

- ✅ 阶段 1（双向通道 + 6 个 page_* 工具 + E2E 验证）**完成**
- 🔜 阶段 2（操作审批流、页面笔记、多 tab 编排）
- ✅ 阶段 3（浮窗改为宿主直出的真实 WebUI + embed 布局）
- 🔜 阶段 4（打包 crx、审批流细化、多 tab 编排）

详见 [docs/BUSINESS_PLAN.md](docs/BUSINESS_PLAN.md)。

## 验证规范（重要）

**绝不启停 3080 生产实例**。所有验证通过独立新端口实例进行：

```bash
# 启动隔离实例（默认 4101，可指定任意端口）
./test/verify-boot.sh 4101
# 停止
./test/verify-boot.sh 4101 stop

# 指向该实例跑测试（token 是 per-port 的）
DSH_BASE=http://127.0.0.1:4101 TOKEN_FILE=test/env/browser-client-token-4101 \
  node test/workflow-store-test.mjs
```

- 每个端口实例有独立 token 文件（`browser-client-token-<port>`）和日志（`boot-<port>.log`）
- 存储后端共享 `$DSH_HOME`，天然验证跨实例持久化

## 网页工作流功能（面向非研发人员）

用户用对话描述重复性网页工作 → LLM 生成可保存/重跑的工作流 → 自动执行。

### 能力一览

| 能力 | 说明 |
|---|---|
| `workflow_generate` 工具 | LLM 把对话需求转化为结构化工作流并保存 |
| `page_record` / `page_highlight` | 录制用户演示 + 元素高亮确认 |
| 执行器 | 按步执行：navigate/action/extract/wait/ask/approve/loop/subflow/branch，重试+ask-user 自愈 |
| 持久化 | storageDomain；不可用时回退到 `$DSH_HOME/browser-workflows.json` |
| 定时触发 | trigger.kind=schedule，30s tick 检查 |
| 技能封装 | 每个工作流自动注册为 DSH skill（模型可发现） |
| 斜杠命令 | `/workflows` 列出、`/run <名>` 运行 |
| 场景模板 | 6 类高频场景（批量填表/采集/搬运/批量操作/多账号/巡检） |
| 模板分享 | export/import 参数化 JSON |
| 面板 UI | 工作流 tab：列表/运行/删除/模板/进度 |

### 工作流数据模型
见 `lib/workflow/schema.js`（WorkflowDefinition + ElementTarget 多路语义定位）。

### 测试
```bash
node test/workflow-store-test.mjs      # 保存/校验/持久化
node test/workflow-executor-test.mjs   # 执行器全链路（ask/approve/重试）
```

## 探索模式（复杂任务的关键能力）

用户需求复杂时，LLM 可能无法一次给出方案。探索模式让 LLM **边操作边学**：
`explore_start` → 反复 `explore_act`（试错，成功/失败都记录）→ `explore_check` 验证目标 → `explore_finish` 把**验证过的成功路径**提炼成干净的工作流（失败的尝试自动丢弃）。

```bash
node test/explore-mode-test.mjs   # 探索→提炼→保存 闭环验证
```

### 面向非研发人员的交互
- 系统提示词段：LLM 用大白话沟通、复述确认需求、主动引导、失败说人话
- 面板探索横幅：实时显示"正在尝试… / 需要你回答… / 完成"
- 场景模板 + 引导式提问，不让普通用户面对空白画布
