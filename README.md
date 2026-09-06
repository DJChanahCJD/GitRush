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

## 架构

```
用户 → Cloudflare Worker → GitHub Archive (ZIP)
              ↓
        流式转发，不落盘、不重新压缩
```

仅支持 GitHub Public Repository 的源码 ZIP 下载，不代理 `git clone`。
