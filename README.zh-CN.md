# vpublish

**把构建好的静态目录发到任何地方。核实真正上线的到底是什么。托管商不行就自动换一个。**

[English](./README.md) · 中文

`vpublish` 是给人和 AI Agent 用的静态发布路由器。指向一个 `dist/`，它会检查产物、挑一个**真能服务它**的
托管商、上传、再把文件抓回来逐字节比对，**只有比对通过才报告 URL**。

```text
dist/ → 检查 → 挑选能服务的托管商 → 上传 → 抓回来 → 比对 SHA-256 → URL
```

上传返回 HTTP 2xx 只是**候选成功**。只有校验通过才会报告成功。

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

## 安装

唯一要求是 Node **22.2+**。这个包**零依赖**——没有安装步骤、没有 `node_modules`、没有 post-install 脚本。

```console
# 从源码跑（现在就能用——包还没上 npm，见「尚未验证」）
$ git clone https://github.com/Inkotake/deploy-cli
$ node deploy-cli/bin/vpublish.mjs ./dist

# 上到 npm 之后
$ npx vpublish ./dist
$ npm install --global vpublish
```

## 用法

```console
$ vpublish ./dist                             # 发到匿名托管，然后校验
$ vpublish plan ./dist --json                 # 会发生什么、为什么（不联网）
$ vpublish ./dist --dry-run                   # 同上，但不上传
$ vpublish deploy ./dist --mode persistent    # 走你自己的 Netlify / Cloudflare / Vercel / GitHub Pages
$ vpublish verify https://… ./dist            # 拿已上线的 URL 与本地构建重新比对
$ vpublish ./dist --json | jq .verification
```

常用参数：`--json`、`--mode`、`--region`、`--provider`、`--dry-run`、`--verify-all`、`--allow-inexact`、
`--proxy`。完整参考见 [`docs/cli.md`](./docs/cli.md)。

## 命令

| 命令 | 作用 |
|---|---|
| `vpublish [dir]` | 等价于 `deploy [dir]`。 |
| `detect` | 找产物；报告注册表、项目标记、git remote、隧道工具。 |
| `inspect` | 建立字节清单、跑安全扫描、列出客户端路由与失效引用。 |
| `plan` | 为某个模式排序候选托管商并解释每个决策。不联网。 |
| `deploy` | 唯一会改动远端状态的命令：上传、校验、报告。 |
| `verify <url> [dir]` | 不上传，直接把已上线的 URL 与本地产物重新比对。 |
| `providers` | 注册表：能力、验证状态、熔断状态、adapter 是否可用。 |
| `claim` | 已存的所有权凭据；`show --reveal` 才打印。 |
| `doctor` | 一次性环境体检。 |
| `tunnel` | 用你机器上已有的隧道工具临时暴露 localhost。 |

## 模式

| 模式 | 行为 |
|---|---|
| `quick-share`（默认） | 匿名临时托管。允许在兼容托管商之间故障转移；URL 会过期。 |
| `persistent` | 账号制持久托管，走你自己的 `netlify` / `wrangler` / `vercel` CLI 或 `git`。**绝不**静默降级成匿名托管。 |
| `tunnel` | 仅本次会话的 localhost 暴露。不是发布，也永远不会被报告为已验证。 |

## 托管商

| 托管商 | 模式 | 验证状态 | HTML 逐字节 | 匿名寿命 |
|---|---|---|---|---|
| ship.page | quick-share | 已实测 | 是 | 30 天 |
| ShipStatic | quick-share | 已实测 | 否（会改写 HTML） | 3 天 |
| here.now | quick-share | 已实测 | 否（会注入 meta 标签） | 24 小时 |
| show | quick-share | 已实测 | 严格 | 48 小时 |
| aft.page | quick-share | 已实测 | 否（返回自己的包装页） | 30 天闲置 |
| Dropley | quick-share | 未验证 | 严格 | 1/3/7 天 |
| **flypod** | quick-share | 已实测（大陆 + 海外两个出口） | 否（会注入自己的渲染插桩） | 14 天 |
| **BrewPage** | quick-share | 已实测（大陆 + 海外两个出口） | 否（会注入自己的顶栏） | 15 天（最长 30 天） |
| **ht-ml.app** | quick-share（单页） | 已实测（大陆 + 海外两个出口） | 是 | 不返回 |
| **meethtml** | quick-share（单页） | 已实测（大陆 + 海外两个出口） | 是 | 24 小时 |
| **shiply.now** | quick-share | 已实测（大陆 + 海外两个出口） | 否（认领前带 claim 横幅） | 24 小时 |
| **Display.dev** | quick-share（单页） | 已实测（大陆 + 海外两个出口） | 否（在它自己的查看器里渲染） | 最长 30 天 |
| **shippage.ai** | quick-share（单页） | 已实测（大陆 + 海外两个出口） | 否（在 /p/&lt;slug&gt; 渲染） | 14 天 |
| Netlify · Cloudflare Pages · Vercel · GitHub Pages | persistent | 预期（未实测） | 是 | 持久 |

`已实测`指协议在真实服务上量过；`预期`指 adapter 按官方 CLI 契约实现、但只跑过失败路径。注册表是唯一真相——
`vpublish providers --json`，实测细节见 [`docs/provider-protocols.md`](./docs/provider-protocols.md)。

持久托管走你机器上已有的 CLI，GitHub Pages 走 `git`。**不会替你安装任何东西**：CLI 缺失时报告为不可用，
而不是下载下来。

## 安全

- **只要安全扫描还有硬阻断项，就什么都不上传。** 规则是固定且通用的：凭据、私钥、敏感目录。
- 扫描**不判断项目特定的数据**——`grades.csv`、`report-card.docx` 都会放行，因为一个工具去猜"这份数据对某个人
  意味着什么"，对其他人一定是错的。需要拒绝这类文件的产品，自己拿 `inspect --json` 的逐路径清单去判断，
  见 [`docs/consuming.md`](./docs/consuming.md)。
- 所有权凭据存在私有状态目录，除非你加 `--show-claim-secret`，否则不会打印。**永远不要转发 claim 值或 URL：
  谁持有它，谁就拥有这个部署。**
- GitHub Pages 被当作共享状态：不属于本工具的分支会被**拒绝**而不是覆盖，`CNAME` 逐字节保留，
  我们自己的推送用 `--force-with-lease`。
- 托管商返回的 URL 必须通过注册表的主机白名单校验——**绝不按命名规则猜**。

## 文档

| | |
|---|---|
| [`docs/cli.md`](./docs/cli.md) | 命令、参数、退出码、JSON 契约、环境变量。 |
| [`docs/verification.md`](./docs/verification.md) | 比对了什么、比对了多少、以及它证明不了什么。 |
| [`docs/provider-protocols.md`](./docs/provider-protocols.md) | 每个 adapter 背后经过实测的契约。 |
| [`docs/consuming.md`](./docs/consuming.md) | 当下游依赖使用（锁版本、自有规则、别名）。 |
| [`docs/releasing.md`](./docs/releasing.md) | 发布到 npm、2FA、凭据卫生。 |
| [`docs/troubleshooting.md`](./docs/troubleshooting.md) | 真正花过时间的那些故障。 |
| [`docs/reachability.md`](./docs/reachability.md) | 哪些托管商在中国大陆可访问，两个出口实测得出。 |

## 尚未验证

- **还没上 npm。** 可以从 clone 直接跑；注册表拒绝没有 2FA 能力的非交互发布。两种完成方式见
  [`docs/releasing.md`](./docs/releasing.md)。
- **持久托管的成功路径**没在真实已登录账号上跑过，只跑过失败路径。在你亲自跑过之前，把 `persistent`
  当作 `预期`。
- 匿名托管在 2026-09-11 做过线上复测并与注册表一致（[证据](./docs/evidence/live-probe-2026-09-11.md)）；
  托管商随时会变，信任旧记录前请重跑 `tools/probe-contracts.mjs`。
- **不做浏览器渲染校验**：WebGL、模块执行、CORS 超出它能证明的范围，它也从不声称做过。

## 开发

```console
$ npm test                       # 单元 + 集成测试，不联网
$ node tools/smoke.mjs           # 命令面、--json 纪律、退出码
$ node tools/check-imports.mjs   # 证明这个包依然零依赖
```

假托管商跑在 `127.0.0.1` 上，所以测试套件从不访问互联网。CI 在 Linux、Windows、macOS × Node 22、24 上跑。

## 许可

MIT，见 [`LICENSE`](./LICENSE)。
