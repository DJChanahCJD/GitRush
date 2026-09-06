# GitHub Downloader

基于 Cloudflare Workers 的 GitHub 源码高速下载代理。粘贴仓库地址，直接下载 ZIP，无需安装客户端。

## 使用

访问首页输入仓库地址，或直接请求：

```
GET /owner/repo                      # 默认分支（main → master 自动回退）
GET /owner/repo?branch=dev           # 指定分支
GET /owner/repo?tag=v1.0.0           # 指定标签
GET /owner/repo?commit=abc1234       # 指定提交（7-40 位 SHA）
```

例如：`/DJChanahCJD/gov-todo` → 返回 `gov-todo-main.zip`（对齐 GitHub 官方命名 `repo-{ref}.zip`）。

branch / tag / commit 最多指定一个；未指定时依次尝试 `main`、`master`。

## 本地开发

```bash
npm install
npm run dev
```

## 部署

```bash
npm run deploy
```

## 性能与防滥用

- **Cache**：Cloudflare Cache API 按请求 URL（repo + ref）缓存归档，TTL 5 分钟；仅缓存成功响应，超大归档超出平台对象上限时自动放弃缓存
- **Rate Limit**：Cloudflare 原生 Ratelimit 绑定（无需 KV），按 IP 限流 10 次/60 秒，超限返回 429
- **请求日志**：结构化 JSON 日志（owner/repo/ref/状态/缓存命中/耗时），`npm run dev` 或 `wrangler tail` 查看
- **元数据**：未指定 ref 时优先通过 GitHub API 解析默认分支（结果缓存 10 分钟），失败时回退 `main → master`

## 架构

```
用户 → Cloudflare Worker → GitHub Archive (ZIP)
              ↓
        流式转发，不落盘、不重新压缩
```

仅支持 GitHub Public Repository 的源码 ZIP 下载，不代理 `git clone`。
