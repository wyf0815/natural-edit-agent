# 安全策略

## 支持版本

当前维护 v9.8 主线。旧版只保留回归与回退参考，不再获得同等级安全修复。

## 报告安全问题

请通过 GitHub Security Advisory 私下报告。不要在公开 Issue 中附带 API Key、桥接令牌、局域网地址、PSD、客户图片或运行日志。

## v9.8 本机桥接保护

- 服务只监听 `127.0.0.1`。
- 除最小健康信息外，业务接口必须提供随机桥接令牌。
- 令牌使用恒定时间比较；健康响应和日志不回显令牌。
- HTTP(S) 浏览器 Origin 被拒绝；只允许无 Origin 或明确的 UXP/插件/Photoshop/文件来源。
- 上游自定义端点必须使用 HTTPS；HTTP 只允许回环地址，URL 不得带账号密码。
- `config.local.json` 损坏或结构错误时业务接口返回失败，不使用部分配置继续运行。
- 分割请求限制并发、大小和缓存；客户端取消会停止排队任务，最后一个共享消费者取消时终止底层推理。

## 秘密的已知风险

API Key 和桥接令牌当前都是本机明文：API Key 可能位于 UXP `localStorage`、环境变量或 `config.local.json`；桥接令牌位于用户运行目录和已安装插件的 `bridge-token.js`。安装/启动脚本会生成 256 位随机令牌并尽量收紧 ACL，但没有接入 Windows Credential Manager。请勿在多人共享 Windows 会话或不可信机器上保存高权限 API Key。

## 发布检查

- 运行 `npm run check`、`npm test` 和 `npm run release:audit`。
- 有批准模型的发布机还应运行 `npm run test:v98:bridge:strict`。
- Photoshop 实机结果单独记录；不能用 Node 或桥接测试代替。
- 不提交 `.env`、`config.local.json`、`bridge-token.js`、`bridge-token.json`、模型、日志或输出文件。
