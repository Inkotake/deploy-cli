# vpublish

**把构建好的静态目录发到任何地方。核实真正上线的到底是什么。托管商不行就自动换一个。**

[English](./README.md) · 中文

`vpublish` 是给人和 AI Agent 用的静态发布路由器。指向一个 `dist/`，它会先检查产物、挑一个**真能服务它**的
托管商、上传、再把文件抓回来逐字节比对，**只有比对通过才报告 URL**。

```text
dist/  →  检查  →  挑选能服务的托管商  →  上传  →  抓回来  →  比对 SHA-256  →  URL
```

上传返回 HTTP 2xx 只是**候选成功**。只有校验通过才会报告成功。

*示例输出：*

```console
$ vpublish ./dist
Inspected 62 files (4.8 MiB), no blocked files
Publishing plan (quick-share, region auto)
  1. ship-page  score=10
Deployment verified.
  provider:  ship-page (temporary)
  url:       https://xxxx.shipped.page/
  expires:   2026-10-11T00:00:00.000Z
  verified:  62 of 62 required resources hash-matched by http-sha256
```

同一次运行的机器可读形式：

```console
$ vpublish ./dist --json | jq '.verification.passed, .url'
true
"https://xxxx.shipped.page/"
```

## 目录

[安装](#安装) · [它比普通上传工具多做什么](#它比普通上传工具多做什么) · [命令](#命令) · [模式](#模式) ·
[退出码](#退出码) · [重点参数](#重点参数) · [「已验证」的准确含义](#已验证的准确含义) ·
[托管商](#托管商) · [安全](#安全) · [状态与环境变量](#状态与环境变量) · [JSON 契约](#json-契约) ·
[开发](#开发) · [省时间的几个坑](#省时间的几个坑) · [尚未验证](#尚未验证) · [独立性、来源与许可](#独立性来源与许可)

## 安装

**从源码跑（现在就能用）：**

```console
$ git clone https://github.com/Inkotake/deploy-cli
$ node deploy-cli/bin/vpublish.mjs ./dist
```

**上到 npm 之后**（见 [尚未验证](#尚未验证)）：

```console
$ npx vpublish ./dist
# 或
$ npm install --global vpublish
```

唯一要求是 Node **22.2+**。这个包**零依赖**——没有安装步骤、没有 `node_modules`、没有 post-install
脚本——所以它也能直接从 tarball 或者离线分发目录里跑。

## 它比普通上传工具多做什么

| | |
|---|---|
| **按能力匹配** | 扩展名白名单不接受 `.glb` 的托管商是**不兼容**，而不是"优先级低一点"。文件数、单文件大小、总体积、目录层级、路径长度、model/`wasm` 支持等限制，全部在**上传之前**判定。 |
| **带熔断的故障转移** | 按顺序尝试兼容的托管商。失败的那家会被熔断（DNS 24 小时、连不上 20 分钟、5xx 10 分钟、限流 1 小时、能力不符 24 小时、完整性 6 小时），下一次运行不会再去撞它。 |
| **发布前安全扫描** | 凭据、私钥、敏感目录一律硬阻断；只要还有阻断项，就什么都不上传。 |
| **发布后逐字节校验** | 每个已部署资源都用 GET 抓回来，与本地清单做 SHA-256 比对。字节不一致、404、content-type 不对、`.js` 被返回成 HTML（SPA 回退陷阱）、或者返回的是托管商的错误页，都算失败。 |
| **私密的所有权凭据** | claim token/URL 存进私有状态目录，除非你显式加 `--show-claim-secret`，否则不会打印。 |
| **稳定的机器契约** | `--json` 在 stdout 只输出一个 JSON 文档（诊断信息走 stderr），退出码有明确文档。 |
| **不可变上传快照** | 走外部 CLI 或 `git` 的托管商，从硬链接快照发布，所以"检查完到上传之间又重建了一次"不会让未经校验的内容上线。 |

## 命令

| 命令 | 作用 |
|---|---|
| `vpublish [dir]` | 等价于 `deploy [dir]`。 |
| `detect [dir]` | 找产物，报告注册表、项目标记、git remote、隧道工具。 |
| `inspect [dir]` | 建立字节清单，跑安全扫描，列出客户端路由与失效引用。 |
| `plan [dir] --mode <mode>` | 为某个模式排序候选托管商，并解释每个决策。不联网。 |
| `deploy [dir] --mode <mode>` | 唯一会改动远端状态的命令：上传、校验、报告。 |
| `verify <url> [dir]` | 不上传，直接把已部署的 URL 与本地产物重新比对。 |
| `providers` | 打印注册表（能力、状态、熔断状态、adapter 是否可用）。 |
| `claim [list\|show [key]]` | 查看已存的所有权凭据；`show` 默认隐藏密钥，加 `--reveal` 才显示。 |
| `doctor [dir]` | 一次性环境体检：运行时、状态目录、policy、region、代理、注册表、托管商。 |
| `tunnel detect\|start` | 用机器上**已经装好**的隧道工具临时暴露 localhost。这里不做任何校验。 |

### 模式

| 模式 | 行为 |
|---|---|
| `quick-share`（默认） | 匿名临时托管。允许在兼容托管商之间故障转移；URL 会过期。 |
| `persistent` | 账号制持久托管，走你自己的 `netlify` / `wrangler` / `vercel` CLI 或 `git`。**绝不**静默降级成匿名临时托管。 |
| `tunnel` | 仅本次会话的 localhost 暴露。明确不是"发布"，也永远不会被报告为已验证。 |

### 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功。 |
| 1 | 上传了但没通过校验，或者发生了意外错误。 |
| 2 | 用法错误。 |
| 3 | 没找到静态产物。 |
| 4 | 安全扫描硬阻断了某个文件。 |
| 5 | 托管商注册表不可用。 |
| 6 | 该模式下没有可用托管商。 |
| 7 | 校验失败。 |
| 8 | 本机不支持隧道工具。 |
| 9 | 没有匹配的已存凭据。 |

## 重点参数

| 参数 | 含义 |
|---|---|
| `--json` | stdout 只输出一个 JSON 文档，诊断走 stderr。 |
| `--region <auto\|cn-mainland\|global>` | `cn-mainland` 让区域内可达的托管商排在分数更高者之前；`auto` 只用它打破平局；`global` 完全忽略区域优先级。 |
| `--verify-all` | 超过 20 MiB 快速校验阈值时也逐文件比对。 |
| `--dry-run` | 打印顺序与载荷，不联系任何托管商；退出码 0，但不会声称完成部署。 |
| `--allow-inexact` | 也把会改写 HTML 的托管商纳入候选（ShipStatic、here.now、aft.page）。它们的 HTML 只做"存在性"检查，其余资源仍然哈希比对。 |
| `--no-verify` | 跳过校验。这样运行永远不会报告成功。 |
| `--provider <id>` | 只尝试指定的托管商。 |
| `--proxy <url>` | 走代理（同样支持 `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`）。 |
| `--show-claim-secret` | 打印所有权凭据，而不只是存起来。 |
| `--force-push`、`--branch <name>` | GitHub Pages：允许覆盖不属于本工具的分支，或发布到别的分支。 |
| `--keep-snapshot` | 保留上传快照并报告其路径。 |

## 「已验证」的准确含义

校验是"比字节"，而且会如实说明做到了哪一步：

- **20 MiB 及以下**逐文件比对。超过阈值时只比对 `index.html`、所有 JS/CSS、所有
  `.glb`/`.gltf`/`.bin`/`.wasm`，以及剩余文件中最大的三个——除非你加 `--verify-all`。结果里
  `filesExpected`（全部文件）与 `filesRequired`（本次实际比对）始终分开给出，人读的 note 也会说明这是**部分**比对。
- HTML 逐字节比对；若该托管商已知会改写 HTML，则 `htmlExact` 为 `false`，并把只做了存在性检查的路径列出来。
- 根文档会**额外用浏览器式请求头再取一次**：因为边缘网络可能只对浏览器注入内容，而对普通 GET 返回原始字节。
  实测：ship.page 对浏览器式 `Accept` 头会注入 Cloudflare Insights beacon（277 字节的页面变成 644 字节）。
  这个结果通过 `browserRepresentation` 与人读 note 如实报告。它**不算失败**（产物确实被正确服务，是第三方包了一层），
  但**绝不会被隐藏**。
- **不做浏览器渲染校验。** WebGL、模块执行、CORS 这类失败超出本工具能证明的范围，它也从不声称做过
  （`browserVerified` 恒为 `false`）。
- 校验无法执行的部署会被当作**失败**，绝不当作成功。

## 托管商

六个匿名托管 + 四个持久托管。状态来自注册表，里面记录了每条结论最后被实测的时间。

| 托管商 | 模式 | 验证状态 | HTML 逐字节 | 匿名寿命 |
|---|---|---|---|---|
| ship.page | quick-share | 已实测 | 是 | 30 天 |
| ShipStatic | quick-share | 已实测 | 否（会改写 HTML） | 3 天 |
| here.now | quick-share | 已实测 | 否（会注入 meta 标签） | 24 小时 |
| show | quick-share | 已实测 | 严格 | 48 小时 |
| aft.page | quick-share | 已实测 | 否（返回自己的包装页） | 30 天闲置 |
| Dropley | quick-share | 未验证 | 严格 | 1/3/7 天 |
| Netlify | persistent | 预期（未实测） | 是 | 持久 |
| Cloudflare Pages | persistent | 预期（未实测） | 是 | 持久 |
| Vercel | persistent | 预期（未实测） | 是 | 持久 |
| GitHub Pages | persistent | 预期（未实测） | 是 | 持久 |

`预期`意味着 adapter 按官方 CLI 契约实现，但只跑过失败路径。**不要把它读成"已实测"。** 注册表是唯一真相：
`vpublish providers --json` 会给出能力、`verification.status` 与熔断状态。

持久托管走你机器上已有的 CLI（`netlify`、`wrangler`、`vercel`），GitHub Pages 走 `git`。**不会替你安装任何东西**；
CLI 缺失时该托管商被报告为不可用，而不是被下载下来。

## 安全

- 任何模式下，**只要安全扫描还有硬阻断项，就什么都不上传**。
- 安全扫描是**固定且通用**的：凭据、私钥、敏感目录。它**不判断项目特定的数据**——`grades.csv`、`roster.csv`、
  `report-card.docx` 都会放行，因为一个上游工具去猜"这份数据对某个人意味着什么"，对其他人一定是错的。
  需要拒绝这类文件的产品自己判断：`inspect --json` 会列出每个路径、大小与哈希，所以它可以在调用 `deploy`
  之前就做决定。见 [`docs/consuming.md`](./docs/consuming.md)。
- 所有权凭据写在私有状态目录的 `claims.json`（文件系统支持时权限 `0600`），报告时不带其值。
  需要时用 `vpublish claim show --reveal` 取。**永远不要转发 claim 值或 claim URL：谁持有它，谁就拥有这个部署。**
- GitHub Pages 被当作共享状态处理：不属于本工具的分支会被**拒绝**而不是覆盖；`CNAME` 逐字节保留；
  我们自己的推送用 `--force-with-lease` 而不是 `--force`。
- 托管商返回的 URL 必须通过注册表的主机白名单校验：**URL 绝不按命名规则猜出来**。

## 状态与环境变量

| 变量 | 作用 |
|---|---|
| `VPUBLISH_HOME` | 状态目录（健康缓存、凭据）。默认 `~/.vpublish`。 |
| `VPUBLISH_REGISTRY` | 使用另一份托管商注册表文件。 |
| `VPUBLISH_STATUS_FILE` | 本地可用性 overlay（只允许改 `enabled`、`priority`、`health`、`lastValidated`、`notes`）。 |
| `VPUBLISH_REGION` | `--region` 的默认值。 |
| `VPUBLISH_DEPLOY_HOME`、`VPUBLISH_DEPLOY_BIN` | 在回退到 `PATH` 之前，去哪里找 `netlify`/`wrangler`/`vercel`。 |
| `HTTPS_PROXY`、`HTTP_PROXY`、`NO_PROXY` | 标准代理变量，每个请求都遵守。 |

旧名字仍然作为回退被读取，所以导出旧变量的部署不受影响：`VERIFIED_PUBLISH_*`（本工具的上一个名字）
以及桌面产品最初的 `TEACHER_DSH_HOME` / `TEACHER_DEPLOY_HOME` / `TEACHER_PUBLISH_REGISTRY` /
`TEACHER_PUBLISH_STATUS_FILE`。

## JSON 契约

每个 `--json` 载荷都以这两个字段开头：

```json
{ "schemaVersion": 1, "command": "deploy", "...": "该命令自己的字段" }
```

`deploy` 成功时给出 `success`、`provider`、`url`、`mode`、`persistence`、`expiresAt`、`claim`、
`snapshot`、`verification`、`attempts`；失败时给出 `provider`、`reason`、`nextAction`、`artifactOk`、
`attempts`——**失败和成功一样是机器可读的**。

## 开发

```console
$ npm test                        # 单元 + 集成测试（node:test，不联网）
$ node tools/smoke.mjs            # 命令面、--json 纪律、退出码
$ node tools/check-imports.mjs    # 证明这个包依然零依赖
$ node tools/probe-contracts.mjs  # 仅维护者：重新实测线上匿名托管商
```

测试覆盖 adapter、校验、规划、注册表 schema、policy 拆分、凭据处理、上传快照、代理链路与 CLI 契约。
`npm test` 里没有任何一步联网：假托管商跑在 `127.0.0.1` 上。

## 省时间的几个坑

- **坏掉的系统代理坏的是 `git`，不是这个工具。** 如果机器的 `http.proxy` 连不上 GitHub，推送会报
  `schannel: failed to receive handshake`，用 `git -c http.proxy= -c https.proxy= push` 绕过。
  另外**不要**设 `GCM_INTERACTIVE=Never`：在非交互 shell 里它会让 Git Credential Manager 无法使用已存凭据。
- **`Invoke-WebRequest -OutFile` 不能当字节比对工具。** 用它下载再比对时写出了 644 字节的文件，
  而另外两个 HTTP 客户端一致得到 277 字节。要比对请用 `vpublish verify`，或用同请求头的 Node/curl。
- **在代理后面**：设 `HTTPS_PROXY` 与 `NO_PROXY`，或用 `--proxy <url>`。请求默认不带压缩，所以校验比对的是源站字节。
- **发布到 npm** 需要一个能满足 2FA 的凭据，见 [`docs/releasing.md`](./docs/releasing.md)。

## 尚未验证

如实列出**还没验证**的部分：

- **还没上 npm。** 源码在 GitHub 上公开、可以 clone 后直接跑，但注册表拒绝没有 2FA 能力的非交互发布
  （`403 … Two-factor authentication or granular access token with bypass 2fa enabled is required`）。
  [`docs/releasing.md`](./docs/releasing.md) 写清了两种完成方式，以及 CI 用的 Trusted Publishing 路线。
- **持久托管的成功路径**（Netlify、Cloudflare Pages、Vercel、GitHub Pages）没有在真实已登录账号上跑过，
  只跑过失败路径。
- 匿名托管在 **2026-09-10** 测过一次，**2026-09-11** 又线上复测：六家全部响应，端点与寿命与注册表一致，
  并且真的部署到 ship.page 后逐文件校验通过（见
  [`docs/evidence/live-probe-2026-09-11.md`](./docs/evidence/live-probe-2026-09-11.md)）。
  托管商随时会变——信任旧记录之前请重跑 `tools/probe-contracts.mjs`。
- **不做浏览器渲染**（设计如此）。
- 隧道中继只是便利功能，不是受支持的发布路径；基于 SSH 的那几个标记为实验性。

## 独立性、来源与许可

`vpublish` 是一个**独立项目**，不是任何产品的组件。它的定位正好相反：它是 **上游**，由 Teacher DSH 教育版
依赖并锁定版本。

代码最初诞生在那个教育版内部——这也是它带有一个可选的 `teacher` 安全策略、并且它的托管商协议是按那个用途
实测的原因。现在这两者在独立工具里都只是普通部件：默认 policy 不含任何教学规则，本仓库也**不 import、
不依赖、不知道**任何下游产品。

- [`docs/provenance.md`](./docs/provenance.md) —— 代码从哪来，以及许可
- [`docs/consuming.md`](./docs/consuming.md) —— 下游产品**可以**依赖什么、**不可以**依赖什么
- [`docs/provider-protocols.md`](./docs/provider-protocols.md) —— 经过实测的托管商契约

包名与命令名都是 `vpublish`；Git 仓库是 [`Inkotake/deploy-cli`](https://github.com/Inkotake/deploy-cli)，
因为 `deploy-cli` 在 npm 上已被占用。仓库名与包名本来就可以独立，而命令名只存在于一个地方
（`src/identity.mjs`）。

MIT，见 [`LICENSE`](./LICENSE)。
