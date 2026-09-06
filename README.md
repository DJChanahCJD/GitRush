# GitHub Downloader

基于 Cloudflare Workers 的 GitHub 源码高速下载代理。粘贴仓库地址，直接下载 ZIP，无需安装客户端。

## 使用

访问首页输入仓库地址，或直接请求：

```
GET /owner/repo
```

例如：`/DJChanahCJD/gov-todo` → 返回 `gov-todo.zip`（默认 `main` 分支）。

## 本地开发

```bash
npm install
npm run dev
```

## 部署

```bash
npm run deploy
```

## 架构

```
用户 → Cloudflare Worker → GitHub Archive (ZIP)
              ↓
        流式转发，不落盘、不重新压缩
```

仅支持 GitHub Public Repository 的源码 ZIP 下载，不代理 `git clone`。
