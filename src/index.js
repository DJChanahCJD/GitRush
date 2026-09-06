/**
 * GitHub 高速下载代理 Worker
 * 流式代理 GitHub 源码 ZIP 归档，不做下载后二次压缩/存储。
 */

/** GitHub 归档文件的基础 URL */
const GITHUB_ARCHIVE = "https://github.com/{owner}/{repo}/archive/refs/heads/{ref}.zip";

/** 默认分支 */
const DEFAULT_REF = "main";

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
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
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
 * 处理下载请求：解析路径并流式转发 GitHub ZIP 归档
 * @param {Request} request 请求对象
 * @param {string} pathname 请求路径
 * @returns {Response} ZIP 流式响应或错误响应
 */
async function handleDownload(request, pathname) {
    const parsed = parsePath(pathname);
    if (!parsed) {
        return errorResponse("路径格式错误，应为 /owner/repo", 400);
    }
    const { owner, repo } = parsed;
    const target = GITHUB_ARCHIVE
        .replace("{owner}", owner)
        .replace("{repo}", repo)
        .replace("{ref}", DEFAULT_REF);

    const upstream = await fetch(target, {
        // 仅转发必要头，避免携带客户端 Cookie 等信息
        headers: { "User-Agent": "github-downloader-worker" },
        redirect: "follow",
    });

    if (!upstream.ok) {
        const message = upstream.status === 404
            ? "仓库不存在或默认分支不是 main"
            : `GitHub 返回错误：${upstream.status}`;
        return errorResponse(message, upstream.status === 404 ? 404 : 502);
    }

    // 流式转发响应体，避免整体读入内存
    return new Response(upstream.body, {
        status: 200,
        headers: {
            "Content-Type": "application/zip",
            "Content-Disposition": `attachment; filename="${repo}.zip"`,
        },
    });
}

/**
 * Worker 入口：静态资源之外的所有请求进入下载逻辑
 * @param {Request} request 请求对象
 * @returns {Response} 响应对象
 */
export default {
    async fetch(request) {
        const { pathname } = new URL(request.url);
        if (request.method !== "GET") {
            return errorResponse("仅支持 GET 请求", 405);
        }
        return handleDownload(request, pathname);
    },
};
