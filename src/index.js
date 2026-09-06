/**
 * GitHub 高速下载代理 Worker
 * 流式代理 GitHub 源码 ZIP 归档，不做下载后二次压缩/存储。
 * Phase 3：Cache API 缓存、Ratelimit 绑定限流、结构化日志、GitHub API 元数据。
 */

/** GitHub 归档 URL 模板 */
const GITHUB_ARCHIVE = "https://github.com/{owner}/{repo}/archive/{path}.zip";

/** GitHub API 仓库元数据 URL 模板 */
const GITHUB_API = "https://api.github.com/repos/{owner}/{repo}";

/** 元数据解析失败时的默认分支候选，按顺序回退 */
const DEFAULT_REFS = ["main", "master"];

/** 归档缓存 TTL（秒） */
const ARCHIVE_CACHE_TTL = 300;

/** 元数据缓存 TTL（秒） */
const API_CACHE_TTL = 600;

/** owner/repo 与 branch/tag/commit 的合法字符 */
const NAME_PATTERN = /^[\w.-]+$/;

/** branch/tag 合法字符（额外允许 / 以支持 feature/x 形式） */
const REF_PATTERN = /^[\w./-]+$/;

/**
 * 解析请求路径，提取 owner / repo
 * 仅接受 /owner/repo 形式，其余一律拒绝
 * @param {string} pathname 请求路径
 * @returns {{owner: string, repo: string} | null} 解析结果，非法时返回 null
 */
function parsePath(pathname) {
    const segments = pathname.split("/").filter(Boolean);
    if (segments.length !== 2) {
        return null;
    }
    const [owner, repo] = segments;
    // owner/repo 仅为 GitHub 合法字符，防止路径注入
    if (!NAME_PATTERN.test(owner) || !NAME_PATTERN.test(repo)) {
        return null;
    }
    return { owner, repo };
}

/**
 * 构造 JSON 错误响应
 * @param {string} message 错误描述
 * @param {number} status HTTP 状态码
 * @returns {Response} 错误响应
 */
function errorResponse(message, status) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { "Content-Type": "application/json; charset=utf-8" },
    });
}

/**
 * 输出结构化请求日志（可通过 wrangler tail / Workers Logs 查看）
 * @param {object} fields 日志字段
 */
function logRequest(fields) {
    console.log(JSON.stringify({ event: "download", time: new Date().toISOString(), ...fields }));
}

/**
 * 通过 GitHub API 元数据解析仓库默认分支（结果缓存 10 分钟）
 * 失败（限流/网络/无数据）返回 null，由调用方回退 main → master
 * @param {Cache} cache Cache API 实例
 * @param {ExecutionContext} ctx 执行上下文，用于 waitUntil
 * @param {string} owner 仓库所有者
 * @param {string} repo 仓库名
 * @returns {Promise<string | null>} 默认分支名
 */
async function getDefaultBranch(cache, ctx, owner, repo) {
    const api = GITHUB_API.replace("{owner}", owner).replace("{repo}", repo);
    const cacheKey = new Request(api);

    const cached = await cache.match(cacheKey);
    if (cached) {
        const data = await cached.json();
        return data.default_branch || null;
    }

    let data;
    try {
        const resp = await fetch(api, {
            headers: {
                "User-Agent": "github-downloader-worker",
                Accept: "application/vnd.github+json",
            },
        });
        if (!resp.ok) return null;
        data = await resp.json();
    } catch {
        return null;
    }
    if (!data.default_branch) return null;

    ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(data), {
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": `public, max-age=${API_CACHE_TTL}`,
        },
    })));
    return data.default_branch;
}

/**
 * 根据查询参数与元数据生成归档路径候选列表
 * branch/tag/commit 最多指定一个；未指定时优先 API 元数据，失败回退 main → master
 * @param {URLSearchParams} searchParams 查询参数
 * @param {Cache} cache Cache API 实例
 * @param {ExecutionContext} ctx 执行上下文，用于 waitUntil
 * @param {string} owner 仓库所有者
 * @param {string} repo 仓库名
 * @returns {Promise<{candidates: string[], label: string, source: string, error: string}>}
 *          candidates 为相对归档路径候选，label 用于文件名，source 为 ref 来源，error 为参数错误描述
 */
async function resolveArchivePaths(searchParams, cache, ctx, owner, repo) {
    const branch = searchParams.get("branch");
    const tag = searchParams.get("tag");
    const commit = searchParams.get("commit");

    if ([branch, tag, commit].filter((v) => v != null).length > 1) {
        return { error: "branch / tag / commit 仅能指定一个", label: "", candidates: [], source: "" };
    }

    if (commit) {
        // commit 为 40 位 SHA（兼容短 SHA）
        if (!/^[0-9a-fA-F]{7,40}$/.test(commit)) {
            return { error: "commit 应为 7-40 位十六进制 SHA", label: "", candidates: [], source: "" };
        }
        return { candidates: [commit], label: commit.slice(0, 7), source: "commit", error: "" };
    }

    if (tag) {
        if (!REF_PATTERN.test(tag) || tag.includes("..")) {
            return { error: "tag 格式非法", label: "", candidates: [], source: "" };
        }
        return { candidates: [`refs/tags/${encodeURIComponent(tag)}`], label: tag, source: "tag", error: "" };
    }

    if (branch) {
        if (!REF_PATTERN.test(branch) || branch.includes("..")) {
            return { error: "branch 格式非法", label: "", candidates: [], source: "" };
        }
        return { candidates: [`refs/heads/${encodeURIComponent(branch)}`], label: branch, source: "branch", error: "" };
    }

    // 未指定：优先 GitHub API 元数据，失败回退固定候选
    const defaultBranch = await getDefaultBranch(cache, ctx, owner, repo);
    if (defaultBranch) {
        return {
            candidates: [`refs/heads/${encodeURIComponent(defaultBranch)}`],
            label: "",
            source: "api",
            error: "",
        };
    }
    return {
        candidates: DEFAULT_REFS.map((ref) => `refs/heads/${ref}`),
        label: "",
        source: "fallback",
        error: "",
    };
}

/**
 * 处理下载请求：缓存查询 → 限流后的上游抓取 → 流式返回
 * @param {Request} request 请求对象
 * @param {ExecutionContext} ctx 执行上下文
 * @returns {Response} ZIP 流式响应或错误响应
 */
async function handleDownload(request, ctx) {
    const start = Date.now();
    const url = new URL(request.url);

    const parsed = parsePath(url.pathname);
    if (!parsed) {
        return errorResponse("路径格式错误，应为 /owner/repo", 400);
    }
    const { owner, repo } = parsed;
    const cache = caches.default;

    // 归档缓存：Cache Key 即请求 URL（天然包含 repo + ref）
    const cached = await cache.match(request);
    if (cached) {
        logRequest({ owner, repo, ref: "cache", status: 200, cache: "hit", ms: Date.now() - start });
        return cached;
    }

    const resolved = await resolveArchivePaths(url.searchParams, cache, ctx, owner, repo);
    if (resolved.error) {
        logRequest({ owner, repo, ref: "invalid", status: 400, cache: "skip", ms: Date.now() - start });
        return errorResponse(resolved.error, 400);
    }

    // 依次尝试候选路径（用于 main/master 自动回退），记录命中项用于文件名
    let upstream = null;
    let hitCandidate = null;
    for (const path of resolved.candidates) {
        const target = GITHUB_ARCHIVE
            .replace("{owner}", owner)
            .replace("{repo}", repo)
            .replace("{path}", path);
        upstream = await fetch(target, {
            // 仅转发必要头，避免携带客户端 Cookie 等信息
            headers: { "User-Agent": "github-downloader-worker" },
            redirect: "follow",
        });
        if (upstream.ok) {
            hitCandidate = path;
            break;
        }
        // 仅 404 时继续尝试下一候选，其余错误直接失败
        if (upstream.status !== 404) break;
    }

    if (!upstream || !upstream.ok) {
        const status = upstream ? upstream.status : 500;
        const message = status === 404
            ? "仓库不存在，或指定的分支/标签/提交不存在"
            : `GitHub 返回错误：${status}`;
        logRequest({ owner, repo, ref: resolved.label || resolved.candidates.join(","), status, cache: "skip", ms: Date.now() - start });
        return errorResponse(message, status === 404 ? 404 : 502);
    }

    // 文件名：repo-{ref}.zip 对齐 GitHub 官方命名；默认分支取实际命中的分支名
    const refLabel = resolved.label || hitCandidate.split("/").pop();

    const headers = {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${repo}-${refLabel}.zip"`,
        "Cache-Control": `public, max-age=${ARCHIVE_CACHE_TTL}`,
    };
    // 透传 Content-Length 便于浏览器显示下载进度
    const contentLength = upstream.headers.get("Content-Length");
    if (contentLength) {
        headers["Content-Length"] = contentLength;
    }

    // 流式转发响应体，避免整体读入内存
    const response = new Response(upstream.body, { status: 200, headers });

    // 缓存成功响应（错误响应一律不缓存）；超大归档超出平台对象上限时 put 自动失败，不影响本次响应
    ctx.waitUntil(cache.put(request, response.clone()).catch(() => {}));

    logRequest({
        owner,
        repo,
        ref: refLabel,
        status: 200,
        cache: "miss",
        bytes: contentLength ? Number(contentLength) : null,
        ms: Date.now() - start,
    });
    return response;
}

/**
 * Worker 入口：限流（Ratelimit 绑定，按 IP 计数）后进入下载逻辑
 * @param {Request} request 请求对象
 * @param {{RATE_LIMITER: {limit: (opts: {key: string}) => Promise<{success: boolean}>}}} env 环境绑定
 * @param {ExecutionContext} ctx 执行上下文
 * @returns {Response} 响应对象
 */
export default {
    async fetch(request, env, ctx) {
        if (request.method !== "GET") {
            return errorResponse("仅支持 GET 请求", 405);
        }

        // 按 IP 限流：超过绑定阈值（10 次/60s）返回 429
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        const result = await env.RATE_LIMITER.limit({ key: ip });
        if (!result.success) {
            return errorResponse("请求过于频繁，请稍后再试", 429);
        }

        return handleDownload(request, ctx);
    },
};
