# 免登录匿名部署服务全网调研：vpublish 扩展路线

> 调研日期：2026-09-13  
> 严格口径：首次发布前不注册、不留邮箱、不 OAuth、不人工登录、不预置 API Key；查看者也不登录。首次响应返回一次性管理密钥仍可归入“免登录”，但必须标记为 generated-secret。  
> 本轮研究包含 57 条服务、路径或排除项；其中 33 条至少声称或证明存在某种严格匿名发布路径。官方一手资料明确支持的新增候选为 16 条，其中 13 条能处理目录、多文件、压缩包或完整应用，另有 3 条偏单 HTML。

## 结论

1. **“真正匿名且可验证的只有已有 6 家”已经过时。** 2026 年新增的 Cloudflare Temporary Accounts 与 Netlify `--allow-anonymous` 改变了格局；另有 Dropage、flypod、DropCat、Sitebin、MindsPage、BrewPage、shiply.now、harvis、Roxer、openpouch、Display.dev 等可脚本化候选。
2. **但“免登录上传成功”不等于 quick-share 成功。** EdgeOne Makers 是最重要的反例：匿名上传真实存在，但独立读取全部 401。只要第三方无法打开，就不能进入默认候选。
3. **先做通用匿名合规测试框架，再写新适配器。** 同一套框架应同时测试 EdgeOne、Cloudflare、Netlify、Dropage、flypod 与 DropCat，避免为每家重复写一次性脚本。
4. **优先顺序：** Cloudflare Temporary、Netlify anonymous、Dropage、flypod、DropCat、Sitebin；EdgeOne只做一次有停止条件的分类实验。随后再测 Display.dev、MindsPage、BrewPage、shiply、harvis、Roxer 与 openpouch。
5. **生命周期字段应在第一批测试时一起接入。** `contentExpiresAt`、`claimDeadline`、`previewAccessExpiresAt` 不能再留空，也不能从营销页硬编码。

## 为什么你对 EdgeOne 的处理是正确的

你已经证明了两件相互独立的事实：

- 未登录状态能够创建临时项目，CLI 返回访问 URL、项目 ID、认领命令与截止时间；
- 返回的 URL、`/index.html` 与资源在带 token / 不带 token 的组合下都返回平台 401，而不是上传产物。

因此，当前最准确的分类不是“匿名静态托管”，而是：

> **login-free upload / console-bound preview / independent-reader unverified**

保持 `enabled: false`、保存失败理由、删除工作区凭据，都是正确工程决策。最后一次复测也只能作为**分类实验**，不能作为“努力把它接进来”的开放式任务：

- 若同出口可读、跨出口 401：标记 `networkBoundPreview`，继续禁用；
- 若同出口和跨出口都可读：才进入普通匿名候选；
- 若始终 401：标记 `loginFreeUploadOnly`，停止投入。

## 严格匿名的准入标准

| 维度 | 必须满足的最低条件 |
|---|---|
| 发布者 | 首次发布前无需账号、邮箱、OAuth、浏览器登录、API Key 或 CAPTCHA |
| 查看者 | 独立设备、独立出口无需登录即可打开最终 URL |
| 自动化 | 存在稳定 CLI、HTTP API、MCP 或可审计协议；纯网页拖拽只能进研究层 |
| 完整性 | 首页及必要资源可取回；明确记录平台改写、包装或注入 |
| 生命周期 | 响应或可靠协议能给出内容到期、认领截止与预览凭据到期 |
| 安全 | claim URL、update token、generated key 被视为 bearer secret，不进公开日志/仓库 |
| 可重复性 | 至少两次发布、一次更新/删除或明确说明不支持 |
| 中国证据 | 只能记录“某探针、某时刻、某 URL/资源”的结果，不能写死 `china: true` |

## 第一优先级候选

| 服务 | 匿名形态 | 产物 | 期限 | 关键风险 |
| --- | --- | --- | --- | --- |
| Cloudflare Workers Temporary Accounts | none; PoW/temporary credentials handled by Wrangler | Worker + Static Assets | 60 minutes unless claimed | Temporary accounts support only selected resources; static assets capped at 1,000 files and 5 MiB each. |
| Netlify anonymous deploy | none | temporary Netlify project | 1 hour unless claimed | Unclaimed project is removed after one hour; confirm CLI JSON and deletion semantics. |
| Dropage | none | HTML / ZIP / TAR / TGZ with root index.html | 1h, 6h, 24h, 7d or 14d | Current homepage limits differ from older agent-skill text; live response must be source of truth. |
| flypod | none | versioned static site | 14 days anonymous | Need test update/rollback tokens, cache behavior, MIME handling and deletion. |
| DropCat | none for first deploy; generated secret returned | ZIP or TAR.GZ | 7 days anonymous | Secret is shown once and cannot be recovered anonymously. Limit: 3 sites, 50 MB, 1,000 files, 5 deploys/hour/IP. |
| Sitebin | none for no-account tier | files/folder/ZIP; SPA fallback | 24 hours anonymous | Homepage wording around scripting is inconsistent; verify hosted API accepts unauthenticated POST in practice. |

### P0 建议顺序

1. **Cloudflare Temporary Accounts**：主流厂商、官方稳定协议、60 分钟、可处理 Static Assets，适合作为“正向基准”。
2. **Netlify anonymous deploy**：主流厂商、CLI 直接支持、1 小时，适合与 Cloudflare 交叉验证通用框架。
3. **Dropage**：中文界面、免注册、目录压缩包、TTL 与访问次数可选，是中国相关匿名分享最值得验证的新对象。
4. **flypod**：目录、版本、更新和回滚，能够验证本地匿名状态管理。
5. **DropCat**：测试首次调用返回 generated-secret 的模型。
6. **Sitebin**：测试无账号静态服务器、SPA fallback、编辑凭据和可选密码。
7. **EdgeOne**：仅做一次受控分类实验，不先写适配器。

## 第二优先级候选

| 服务 | 范围 | 接口 | 期限 | 建议 |
| --- | --- | --- | --- | --- |
| MindsPage | single HTML and multi-file ZIP static site | HTTP API + browser | page 3h default/up to 24h; claim can extend; site lifetime must be read from response | P1 probe |
| BrewPage | single HTML/Markdown/files and multi-file ZIP site | REST API, OpenAPI, MCP | 15 days default, 30 days max | P1 probe |
| shiply.now | multi-file static/dynamic publishing | REST three-step upload, CLI, remote MCP | 24 hours anonymous | P1 probe |
| harvis | multi-file directory static hosting | CLI, HTTP API, remote MCP | unclaimed lifetime not clearly stated on landing pages; response/terms must decide | P1 probe |
| Roxer Quick Sharing | single files, directories and ZIPs | browser, CLI, MCP, API | 30 days for no-signup pages | P1 probe |
| openpouch | static directory or Node app | CLI / JSON output / MCP | 72h anonymous; private claim link extends to 7d | P1 dynamic-plugin probe |
| Display.dev claimable publishing | HTML/Markdown and directories | curl, CLI, public/local MCP | 30 days live; claim remains usable another 30 days | P1 probe |
| meethtml | single HTML/Markdown page | REST API, local/hosted MCP | 24 hours anonymous | P1 single-page adapter |
| ShipPage / shippage.ai | single HTML or Markdown page | REST API, MCP, skill | 14 days free | P1 single-page adapter |
| ht-ml.app | single HTML plus referenced assets | REST API and WebMCP | not clearly disclosed on public help; response/terms must decide | P1 single-page adapter |

## 浏览器免注册但暂不适合适配器

| 服务 | 范围 | 期限 | 为什么不进默认适配器 |
| --- | --- | --- | --- |
| PreviewShip no-signup browser publishing | browser upload preview | current facts page says 3-day retention | CLI requires authentication and MCP requires API key, so it is not an adapter candidate without browser automation. |
| PageDrop.io | single HTML page | reported 1h/1d/7d/30d or one-time view | No stable machine API confirmed; public gallery/privacy behavior requires review. |
| PageDrop (fluxath) | multi-file browser upload | reported 30 days, with conflicting inactivity wording | Name collision with unrelated PageDrop products; endpoint and retention must be identified exactly. |
| SharingHTML | small multi-file browser upload | reported 7 days | Reported quotas and API status need current verification. |
| dochost no-account mode | document/HTML browser upload | reported 3 days private / 7 days public | Not a general directory host; programmatic path is not strict anonymous. |
| ShareMyHTML | single HTML browser upload | site claims persistent/no expiry; verify | No documented API, deletion or retention contract found. |
| HTMLPub | single HTML browser upload | unclear | The API requires Pro; do not infer API anonymity from the free browser uploader. |

## 明确排除或另行分类

| 服务/类别 | 实际要求/性质 | 状态 | 原因 |
| --- | --- | --- | --- |
| HTMLPub | browser may be no-signup; API is paid/authenticated | browser-only-not-api-anonymous | The API requires Pro; do not infer API anonymity from the free browser uploader. |
| AgentDrop | depends on operator | not-public-provider | Do not list as a public service unless a maintained hosted endpoint is verified. |
| LiveCodes | none for shareable encoded projects | playground-not-hosting | Runtime wrapper and external dependencies change semantics. |
| JSFiddle anonymous fiddle | none for basic fiddle creation | playground-not-hosting | Not byte-preserving static hosting and not intended for arbitrary build output. |
| Tiiny Host anonymous-looking API | email-gated first-use workflow | not-strict-anonymous | A new email/first-use flow is a credential requirement. |
| Surge | email/account created on first run | not-strict-anonymous | Free does not mean no-login. |
| Neocities | account/API key required | not-strict-anonymous | API credentials are mandatory. |
| Static.run | account flow for publishing/management | not-strict-anonymous | Small single-file limit and account requirement make it unsuitable for this strict lane. |
| host-html | account/API key required for API | not-strict-anonymous | Marketing may say instant/free while the machine path still needs credentials. |
| Upma | token/free account | not-strict-anonymous | A free token is still a login credential. |
| Sharable.link | current product requires account | not-strict-anonymous | Historical anonymous behavior must not be confused with the current contract. |
| Cloudflare Pages normal workflow | account/token required | not-strict-anonymous | Do not conflate Pages free plan with Workers temporary accounts. |
| Netlify normal persistent deploy | account/token required | not-strict-anonymous | The anonymous one-hour project is a distinct flow. |
| GitHub Pages | GitHub account required | not-strict-anonymous | Public access does not imply anonymous publishing. |
| PreviewShip CLI / MCP | CLI login or API key | not-strict-anonymous | Only the browser no-signup path qualifies; CLI and MCP do not. |
| EasySend/raw file sharing | may be anonymous | file-share-not-hosting | A downloadable archive is not a browser-rendered static site. |
| Quick tunnels (Cloudflare, ngrok, cpolar, NATAPP, Sakura Frp) | varies; some no-account | tunnel-not-deployment | Machine shutdown, process exit or network loss ends availability. |

## 通用匿名提供商合规测试框架

建议新增命令：

`vpublish conformance <provider> --fixture <name> --egress <profile> --json`

### 固定测试样本

| 样本 | 目的 |
|---|---|
| `minimal` | 277 字节或更小的唯一文本，检测错误页、包装页和缓存 |
| `assets` | `index.html + assets/app.js + style.css + font`，验证相对路径、MIME 与资源完整性 |
| `spa` | 深层路由刷新，验证 fallback/rewrites |
| `unicode` | 中文目录、文件名、标题和 URL 编码 |
| `wasm-3d` | WASM、GLB/GLTF 与大写扩展，暴露 allowlist 问题 |
| `limits` | 文件数、单文件大小和总大小边界，不在公共服务上做破坏性压力测试 |

### 每次发布必须记录

`uploadSucceeded`、`sameEgressRead`、`crossEgressRead`、`independentReaderVerified`、`assetsVerified`、`htmlTransform`、`contentExpiresAt`、`claimDeadline`、`previewAccessExpiresAt`、`deleteSupported`、`testedAt`、`networkEvidence`。

### EdgeOne 一次性测试矩阵

| 变量 | 值 |
|---|---|
| 站点 | china、global 各最多一次新部署 |
| 部署出口 | 当前 CLI 相同代理链路，记录匿名出口指纹，不公开原始 IP |
| 读取出口 | 同一代理；直连；第二独立网络 |
| 路径 | CLI 原样 URL、`/`、`/index.html`、一个静态资源 |
| 凭据 | 原样 query；无 query；只保留 eo_token/eo_time 的规范组合 |
| 延时 | 0、2、5、15、30、60 秒 |
| 请求 | curl 默认；浏览器常见头；跟随重定向 |
| 证据 | 状态、Location、MIME、body 长度/hash、Server/Via/request-id、最终 URL |

**停止条件：** 一次 China + 一次 Global 已足够。若跨出口不通过，保持禁用，不再把“同出口能开”解释成 quick-share。

## 注册表建议

`free: true` 和 `anonymous: true` 已经不够。建议加入：

`publisherAuth`: none | generated-secret | email-gated | account-token  
`viewerAccess`: public | query-token | password | same-ip | cookie  
`artifactModel`: directory | archive | single-html | wrapper | ipfs | tunnel  
`verificationClass`: byte-exact | semantically-equivalent | wrapped | unknown  
`shareability`: independent-public | network-bound | owner-preview | unverified  
`lifecycle`: contentExpiresAt | claimDeadline | previewAccessExpiresAt | idleExpiry  
`evidence`: sourceUrl | checkedAt | liveTestedAt | testCommit | resultDigest  

默认 quick-share 只允许：

`publisherAuth in {none, generated-secret}` + `viewerAccess=public` + `shareability=independent-public` + `scriptable=true` + 已知或机器可读 TTL。

## 项目路线图

### PR 1：匿名合规框架 + 生命周期字段

- 增加固定 fixture、跨出口读取接口、证据 JSON 与 secret redaction；
- 把现有六家接入相同测试；
- 从响应提取 TTL/claim，而不是从注册表静态猜测；
- 验收：失败不会打印 claim/update token，且证据能复现“错误页 200”“401”“资源缺失”“HTML 改写”。

### PR 2：EdgeOne 最终分类

- 只跑上面的受控矩阵；
- 结果落入 `independent-public`、`network-bound` 或 `login-free-upload-only`；
- 只有第一类允许开启适配器。

### PR 3：两家主流官方匿名路径

- Cloudflare `wrangler deploy --temporary`；
- Netlify `netlify deploy --allow-anonymous`；
- 验收：未登录、第三方可读、TTL/claim 可解析、过期后行为可观测。

### PR 4：中国相关与小型原生 API

- Dropage、flypod、DropCat；
- 测 archive 解压、中文文件名、SPA、字体/WASM、删除与更新；
- 不因第一家失败而未经许可把内容继续上传到多家。

### PR 5：扩展层

- Sitebin、Display.dev、MindsPage、BrewPage、shiply、harvis、Roxer；
- openpouch 进入动态部署插件，不膨胀静态核心；
- 单 HTML 服务进入 `singlePage` 能力类，不与目录托管混选。

## 重要产品建议

1. **不要把 generated-secret 偷偷当成无状态。** DropCat、BrewPage、ShipPage、ht-ml 等首次调用会返回唯一管理密钥。CLI 必须询问/声明存储位置，并支持 `--no-save`。
2. **匿名回退需要数据接收方许可。** 自动 fallback 到十家平台会把内容复制给十个第三方。默认只在用户批准的 provider set 内重试。
3. **错误页 200 与平台包装必须有指纹。** 用唯一 nonce、body hash、标题、资源 hash 与 expected marker，而不是仅看 HTTP 200。
4. **到期提醒不是保活机器人。** 工具可以导出、认领、迁移和提醒，但不要用无意义访问规避服务的 idle policy。
5. **来源事实与运行时安全边界分离。** 调研目录可以远程更新；可执行端点、命令和令牌接收域仍须代码审查和 allowlist。
6. **建立匿名服务墓地。** 保存退役、改成登录、协议变更和最后成功时间，避免未来再次采信过时博客。

## 证据等级与限制

- **A**：你或仓库已有真实部署/读取证据；
- **B**：当前官方文档给出明确匿名协议；
- **C**：官方营销页或开源 README 声称支持，尚未做独立读取测试；
- **D**：第三方、冲突或历史材料，仅研究；
- **E**：明确不满足严格匿名或不是部署。

本轮助手环境没有执行外网 POST/部署，因此**没有把任何新增候选写成“已实测可用”**。新增项的事实来自当前官方页面，最终启用仍应由合规测试框架给出 A 级证据。中国可用性也未由本轮多地区、多运营商探针证明。

## 完整矩阵

机器可读文件：`anonymous-provider-matrix.json` 与 `anonymous-provider-matrix.csv`。下表为全部 57 条记录的紧凑视图。

| 服务 | 状态 | 发布认证 | 范围 | 期限 | 优先级 | 证据 |
| --- | --- | --- | --- | --- | --- | --- |
| ship.page | strict-anonymous | none | multi-file / existing adapter | Docs conflict: 7 vs 30 days; response expiry must win | keep + repair lifecycle | A: user/repo live + official |
| ShipStatic | strict-anonymous | none | multi-file / existing adapter | about 3 days in current repo observations | keep | A: repo live observation |
| here.now | strict-anonymous | none | multi-file / existing adapter | 24 hours anonymous | keep | A/B: repo live + official docs |
| Show | strict-anonymous | none | multi-file / existing adapter | about 48 hours in current repo observations | keep with compatibility filter | A: repo live observation |
| aft.page | strict-anonymous-wrapper | none | wrapper / existing adapter | about 30 days idle in current observations | keep but never choose for exact hosting | A: repo live observation |
| Dropley | strict-anonymous-experimental | none | multi-file / existing experimental adapter | 1/3/7 days in current integration | keep disabled/experimental | A: repo live observation |
| EdgeOne Makers anonymous | login-free-upload-not-shareable | none before deploy | multi-file CLI | claim deadline returned by CLI; preview token has a separate lifetime | one controlled classification test only | A: user live test |
| Cloudflare Workers Temporary Accounts | strict-anonymous-candidate | none; PoW/temporary credentials handled by Wrangler | multi-file/static assets + Worker | 60 minutes unless claimed | P0 probe | B: official contract |
| Netlify anonymous deploy | strict-anonymous-candidate | none | multi-file directory | 1 hour unless claimed | P0 probe | B: official contract |
| Dropage | strict-anonymous-candidate | none | HTML or archive static site | 1h, 6h, 24h, 7d or 14d | P0 probe | B: official site/API guide |
| flypod | strict-anonymous-candidate | none | multi-file directory | 14 days anonymous | P0 probe | B: official docs |
| DropCat | strict-anonymous-generated-secret | none for first deploy; generated secret returned | archive static site | 7 days anonymous | P0 probe | B: official API reference |
| Sitebin | strict-anonymous-candidate | none for no-account tier | multi-file static server or file viewer | 24 hours anonymous | P0/P1 probe | B: official hosted site + open-source code |
| MindsPage | strict-anonymous-candidate | none | single HTML and multi-file ZIP static site | page 3h default/up to 24h; claim can extend; site lifetime must be read from response | P1 probe | B: official API page |
| BrewPage | strict-anonymous-generated-secret | none; generated owner token returned | single HTML/Markdown/files and multi-file ZIP site | 15 days default, 30 days max | P1 probe | B: official API reference |
| shiply.now | strict-anonymous-candidate | none for first publish | multi-file static/dynamic publishing | 24 hours anonymous | P1 probe | B: official docs |
| harvis | strict-anonymous-candidate | none | multi-file directory static hosting | unclaimed lifetime not clearly stated on landing pages; response/terms must decide | P1 probe | B: official docs |
| Roxer Quick Sharing | strict-anonymous-candidate | none | single files, directories and ZIPs | 30 days for no-signup pages | P1 probe | B: official site |
| openpouch | strict-anonymous-candidate | none | static directory or Node app | 72h anonymous; private claim link extends to 7d | P1 dynamic-plugin probe | B: official docs and open source |
| Display.dev claimable publishing | strict-anonymous-candidate | none | HTML/Markdown and directories | 30 days live; claim remains usable another 30 days | P1 probe | B: official docs |
| meethtml | strict-anonymous-single-page | none | single HTML/Markdown page | 24 hours anonymous | P1 single-page adapter | B: official API docs |
| ShipPage / shippage.ai | strict-anonymous-generated-secret | none on first call; generated API key returned | single HTML or Markdown page | 14 days free | P1 single-page adapter | B: official site |
| ht-ml.app | strict-anonymous-generated-secret | none for create; generated update key returned | single HTML plus referenced assets | not clearly disclosed on public help; response/terms must decide | P1 single-page adapter | B: official API help |
| pastehtml.dev | strict-anonymous-single-page-unverified | none | single HTML page | retention described as persistent/unclear; verify | P2 probe | C: official marketing/API page, needs probe |
| ShareYourHTML | strict-anonymous-single-page-unverified | none | single HTML page | reported 7/30/90 days or never; verify current API | P2 probe | C: official site, needs live probe |
| DropWeb | strict-anonymous-experimental | none on first deploy; generated key/account state | multi-file archive/site | about 3 days in project claims | P2 probe | C: open-source project/marketing |
| StaticHub | strict-anonymous-experimental | none for anonymous mode | file or directory static site | unclear | P2 research | C: open-source README |
| PinMe | strict-anonymous-adjacent | none for basic CLI path | directory to IPFS/IPNS-style hosting | content persistence is not equivalent to guaranteed retention | P2 plugin research | C: official project page |
| PreviewShip no-signup browser publishing | strict-anonymous-browser-only | none in browser trial | browser upload preview | current facts page says 3-day retention | research/browser only | B/C: official facts/quickstart |
| PageDrop.io | strict-anonymous-browser-only | none | single HTML page | reported 1h/1d/7d/30d or one-time view | research/browser only | C: official browser product |
| PageDrop (fluxath) | strict-anonymous-browser-only-unverified | none | multi-file browser upload | reported 30 days, with conflicting inactivity wording | research only | D: small official page, conflicting details |
| SharingHTML | strict-anonymous-browser-only-unverified | none | small multi-file browser upload | reported 7 days | research only | D: small site, no stable API confirmed |
| dochost no-account mode | strict-anonymous-browser-only | none in browser path | document/HTML browser upload | reported 3 days private / 7 days public | research/browser only | C: official site |
| ShareMyHTML | strict-anonymous-browser-only-unverified | none | single HTML browser upload | site claims persistent/no expiry; verify | research/browser only | C: official site |
| HTMLSave | unverified | none/unclear for basic path | single HTML browser upload | unclear | research only | D: marketing only |
| HTMLPub | browser-only-not-api-anonymous | browser may be no-signup; API is paid/authenticated | single HTML browser upload | unclear | exclude from adapter | B/C: official docs |
| OneClickLive | contradictory | claims conflict | single/multi-page browser publish | reported 7 days in no-account path | research only | D: official pages conflict |
| Unofficial Vercel claimable deployment wrapper | experimental-not-official | none to wrapper | static preview | unknown | do not default-enable | D: third-party skill, not an official Vercel public contract |
| 1freehosting / npx hosting | unverified | claimed none | static folder | reported 24h idle plus claim path | research only | D: author article/legacy claim |
| AgentDrop | not-public-provider | depends on operator | self-hostable anonymous deployment implementation | operator-defined | architecture reference, not public provider | C: open-source project |
| itty.bitty.site | not-conventional-hosting | none | URL-encoded tiny page | URL itself persists | optional tiny-page utility | B/C: known official project |
| LiveCodes | playground-not-hosting | none for shareable encoded projects | code playground | URL/storage dependent | exclude from static provider registry | B: official project |
| JSFiddle anonymous fiddle | playground-not-hosting | none for basic fiddle creation | code playground | not a deployment SLA | exclude | B/C |
| Tiiny Host anonymous-looking API | not-strict-anonymous | email-gated first-use workflow | HTML/ZIP hosting | trial-specific | exclude from strict anonymous | B: official developer docs |
| Surge | not-strict-anonymous | email/account created on first run | directory static hosting | persistent under account | exclude from strict anonymous; keep in account-based catalog | B: official docs |
| Neocities | not-strict-anonymous | account/API key required | static files | account-based | exclude from strict anonymous | B: official API docs |
| Static.run | not-strict-anonymous | account flow for publishing/management | static site | plan-based | exclude from strict anonymous | B/C: official pricing/product |
| host-html | not-strict-anonymous | account/API key required for API | HTML hosting | plan-based | exclude | C: official product |
| HTMLPUT | contradictory | conflicting claims | HTML hosting | unclear | exclude pending live proof | D: contradictory |
| Upma | not-strict-anonymous | token/free account | static page/site | account-based | exclude from strict anonymous | C: official project |
| Sharable.link | not-strict-anonymous | current product requires account | hosted content | account-based | exclude; old anonymous endpoints are legacy only | C: current product |
| Cloudflare Pages normal workflow | not-strict-anonymous | account/token required | static site | persistent account resource | exclude from strict lane; temporary Workers path is separate | B: official docs |
| Netlify normal persistent deploy | not-strict-anonymous | account/token required | static/app deployment | account resource | exclude from strict lane; --allow-anonymous is separate | B |
| GitHub Pages | not-strict-anonymous | GitHub account required | static site from repository | account/repository based | exclude from strict anonymous | B |
| PreviewShip CLI / MCP | not-strict-anonymous | CLI login or API key | site preview | plan-based | exclude from strict adapter lane | B: official docs |
| EasySend/raw file sharing | file-share-not-hosting | may be anonymous | file transfer | varies | exclude from web deployment providers | C/D |
| Quick tunnels (Cloudflare, ngrok, cpolar, NATAPP, Sakura Frp) | tunnel-not-deployment | varies; some no-account | live local service exposure | process/session lifetime | keep as a separate mode, never call deployment | B/C |

## 主要来源

- Cloudflare Temporary Accounts: https://developers.cloudflare.com/workers/platform/claim-deployments/
- Netlify anonymous deploy: https://docs.netlify.com/deploy/create-deploys/
- Dropage: https://dropage.online/
- flypod: https://docs.flypod.dev/docs
- DropCat: https://drop.cat/help/
- Sitebin: https://sitebin.io/
- MindsPage: https://mindspage.com/
- BrewPage: https://brewpage.app/api
- shiply.now: https://shiply.now/docs
- harvis: https://harvis.dev/downloads/command-line
- Roxer: https://www.roxer.com/
- openpouch: https://openpouch.dev/deploy-without-signup
- Display.dev: https://display.dev/docs/claimable
- meethtml: https://meethtml.com/docs
- ShipPage: https://shippage.ai/
- ht-ml.app: https://api.ht-ml.app/v1/help
