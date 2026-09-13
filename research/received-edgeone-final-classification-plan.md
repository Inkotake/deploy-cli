# EdgeOne 匿名部署最终分类测试

## 目标

不是“证明 EdgeOne 一定能接入”，而是只回答一个问题：**匿名部署返回的 URL 是否能被独立读者稳定打开。**

## 前置原则

- 最多新建 China、Global 各一个匿名项目；
- 只上传无敏感信息的唯一测试页；
- claim SID、eo_token、eo_time、anonymous.json 全部按 bearer secret 处理；
- 运行结束立即清理本地凭据；
- 不把原始出口 IP 写进公开日志，只保存不可逆指纹和网络标签。

## 样本

index.html 包含随机 nonce；assets/app.js 运行后把同一 nonce 写到 DOM；style.css 设置可检测样式。记录三个文件本地 SHA-256。

## 执行矩阵

1. 部署：site=china，使用与读取“同出口”配置。
2. 按 0/2/5/15/30/60 秒读取：原样 URL、根路径、index、app.js。
3. 每个路径测试原 query、无 query、规范 token query；curl 默认头和浏览器头各一次。
4. 再从直连和第二独立网络重复读取。
5. site=global 重复一次。

## 记录字段

status、finalUrl、location、contentType、contentLength、bodySha256、expectedNonceFound、server、via、requestId、egressFingerprint、delayMs、site、tokenMode、headerProfile。

## 分类

- same + cross egress 均通过：首页和资源与 nonce 一致 → independent-public，可进入适配器开发。
- 仅 same egress 通过 → network-bound-preview，继续 enabled=false。
- 全部 401/平台错误页 → login-free-upload-only，停止重试。
- 页面通过但资源失败 → partial-preview，继续禁用并记录限制。

## 完成标准

输出一个不含 secret 的 JSON 证据包；注册表只更新分类、checkedAt、reason、testCommit，不更新为 enabled=true，除非 independent-public 全部通过。
