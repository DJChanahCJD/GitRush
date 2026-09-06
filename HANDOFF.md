# GitHub 高速下载代理

## 1. 项目目标

构建一个基于 **Cloudflare Workers** 的极简 GitHub 源码下载代理。

核心体验：

```text
粘贴 GitHub 仓库地址
        ↓
Cloudflare Worker
        ↓
GitHub Source Archive
        ↓
直接下载 ZIP
```

目标不是实现完整 Git Clone 代理，而是解决国内用户：

- GitHub 源码下载慢
- ZIP 下载失败/卡顿
- 不想配置代理
- 不想安装客户端

---

## 2. MVP 范围

### 必须支持

- GitHub Public Repository
- `https://github.com/owner/repo`
- 默认 `main` 分支
- Worker 流式代理 ZIP
- 正确设置下载文件名
- 基础错误处理

### 后续可选

- 自动识别 `main/master`
- 指定 branch
- 指定 tag
- 指定 commit
- TAR.GZ
- GitHub Repository 信息展示
- Cache
- Rate Limit
- 简单 Web UI

### 暂不做

- Git Smart HTTP / `git clone` 加速
- 私有仓库
- 用户登录
- 数据库
- R2
- Python 后端
- 自建服务器

---

## 3. 核心技术方案

### Worker

使用 Cloudflare Workers，直接 `fetch()` GitHub Archive。

例如：

```text
https://github.com/DJChanahCJD/gov-todo
        ↓
https://github.com/DJChanahCJD/gov-todo/archive/refs/heads/main.zip
```

Worker 不下载后再重新压缩。

而是：

```text
GitHub Response
      ↓
ReadableStream
      ↓
Cloudflare Worker
      ↓
用户
```

保持流式传输，避免不必要的内存占用。

---

## 4. 推荐 API

```text
GET /owner/repo
```

例如：

```text
GET /DJChanahCJD/gov-todo
```

返回：

```text
gov-todo.zip
```

后续可扩展：

```text
GET /owner/repo?branch=dev
GET /owner/repo?tag=v1.0.0
GET /owner/repo?commit=xxxx
```

---

## 5. URL 解析

允许用户输入：

```text
https://github.com/owner/repo
https://github.com/owner/repo/
```

需要拒绝：

```text
github.com/owner
github.com/owner/repo/issues
github.com/owner/repo/pull/1
非 github.com 域名
```

解析后得到：

```text
owner
repo
ref
```

默认：

```text
ref = main
```

---

## 6. 核心 Worker 逻辑

伪代码：

```js
async function handle(request) {
    const { owner, repo, ref } = parseGithubUrl(request)

    const target =
        `https://github.com/${owner}/${repo}/archive/refs/heads/${ref}.zip`

    const response = await fetch(target)

    if (!response.ok) {
        return error(...)
    }

    return new Response(response.body, {
        status: response.status,
        headers: {
            "Content-Type": "application/zip",
            "Content-Disposition":
                `attachment; filename="${repo}.zip"`
        }
    })
}
```

注意：

**不要 `await response.arrayBuffer()` 再返回。**

优先：

```js
new Response(response.body)
```

实现流式代理。

---

## 7. 架构原则

整个项目保持极简：

```text
github-downloader/
├── src/
│   └── index.js
├── public/
│   └── index.html
├── wrangler.toml
├── package.json
└── README.md
```

如果 Web UI 不需要复杂交互，优先使用：

```text
原生 HTML
原生 CSS
少量 JavaScript
```

不要引入 React / Next.js / shadcn 等重型前端框架。

---

## 8. Web UI

MVP 页面只需要：

```text
GitHub Downloader

[ GitHub Repository URL             ]

[ Download ZIP ]

------------------------------------

支持 GitHub Public Repository
无需安装客户端
```

原则：

- 单页面
- 无登录
- 无数据库
- 移动端可用
- 快速加载
- 简洁 UI

---

## 9. Cache / Rate Limit

MVP 完成后再考虑。

### Cache

可以缓存 GitHub Archive 响应，但需要注意：

- 不要缓存错误响应
- Cache Key 应包含 repository + ref
- 大文件缓存需要结合 Cloudflare 限制评估

### Rate Limit

防止 Worker 被滥用：

```text
IP → 请求计数 → 超过阈值 → 429
```

如果没有 KV，MVP 可以暂时不实现复杂限流。

---

## 10. Git Clone 不作为 MVP

不要把项目定义成：

> GitHub Git Clone 加速器

因为：

```text
git clone
```

涉及 Git Smart HTTP、upload-pack、packfile 等协议，不等价于下载 ZIP。

当前项目准确定位：

> **GitHub 源码高速下载代理**

即：

```text
GitHub URL → ZIP
```

如果未来需要支持：

```bash
git clone https://xxx/owner/repo.git
```

再单独设计 Git Proxy。

---

## 11. 开发顺序

### Phase 1 — MVP

1. 创建 Cloudflare Worker
2. 实现 GitHub URL 解析
3. 代理 `archive` ZIP
4. 流式返回
5. 错误处理
6. 本地测试
7. 部署

### Phase 2 — 可用性

1. Web UI
2. main/master 自动判断
3. branch/tag 支持
4. 下载文件名优化
5. README

### Phase 3 — 性能与防滥用

1. Cache
2. Rate Limit
3. 请求日志/统计
4. GitHub API 元数据

---

## 12. 当前决策

核心技术选择：

```text
Cloudflare Workers
        +
GitHub Archive
        +
Streaming Proxy
        +
原生 HTML UI
```

核心原则：

> **能直接转发，就不要自己下载、存储、压缩。**

> **能用 Cloudflare 原生能力，就不要引入额外后端。**

> **先完成 ZIP 下载 MVP，再考虑 Clone、缓存、限流等扩展。**

---

## 13. Agent 下一步

直接开始实现 **Phase 1 MVP**。

优先产出：

```text
src/index.js
wrangler.toml
package.json
README.md
```

完成后验证：

```text
GET /DJChanahCJD/gov-todo
```

能够正常返回：

```text
gov-todo.zip
```

然后再实现最小 Web UI。