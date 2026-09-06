/**
 * GitHub 高速下载代理 Worker
 * 流式代理 GitHub 源码 ZIP 归档，不做下载后二次压缩/存储。
 */

/** GitHub 归档 URL 模板 */
const GITHUB_ARCHIVE = "https://github.com/{owner}/{repo}/archive/{path}.zip";

/** 未指定 ref 时的默认分支候选，按顺序回退 */
const DEFAULT_REFS = ["main", "master"];

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
 * 根据查询参数生成归档路径候选列表与下载文件名
 * branch/tag/commit 最多指定一个；未指定时依次回退 main → master
 * @param {URLSearchParams} searchParams 查询参数
 * @returns {{candidates: string[], label: string, error: string} | null}
 *          candidates 为相对归档路径候选，label 用于文件名，error 为参数错误描述
 */
function resolveArchivePaths(searchParams) {
    const branch = searchParams.get("branch");
    const tag = searchParams.get("tag");
    const commit = searchParams.get("commit");

    if ([branch, tag, commit].filter((v) => v != null).length > 1) {
        return { error: "branch / tag / commit 仅能指定一个", label: "", candidates: [] };
    }

    if (commit) {
        // commit 为 40 位 SHA（兼容短 SHA）
        if (!/^[0-9a-fA-F]{7,40}$/.test(commit)) {
            return { error: "commit 应为 7-40 位十六进制 SHA", label: "", candidates: [] };
        }
        return {
            candidates: [commit],
            label: commit.slice(0, 7),
        };
    }

    if (tag) {
        if (!REF_PATTERN.test(tag) || tag.includes("..")) {
            return { error: "tag 格式非法", label: "", candidates: [] };
        }
        return {
            candidates: [`refs/tags/${encodeURIComponent(tag)}`],
            label: tag,
        };
    }

    if (branch) {
        if (!REF_PATTERN.test(branch) || branch.includes("..")) {
            return { error: "branch 格式非法", label: "", candidates: [] };
        }
        return {
            candidates: [`refs/heads/${encodeURIComponent(branch)}`],
            label: branch,
        };
    }

    // 未指定：依次尝试默认分支候选
    return {
        candidates: DEFAULT_REFS.map((ref) => `refs/heads/${ref}`),
        label: "",
    };
}

/**
 * 处理下载请求：解析路径并流式转发 GitHub ZIP 归档
 * @param {Request} request 请求对象
 * @param {string} pathname 请求路径
 * @param {URLSearchParams} searchParams 查询参数
 * @returns {Response} ZIP 流式响应或错误响应
 */
async function handleDownload(request, pathname, searchParams) {
    const parsed = parsePath(pathname);
    if (!parsed) {
        return errorResponse("路径格式错误，应为 /owner/repo", 400);
    }
    const { owner, repo } = parsed;

    const resolved = resolveArchivePaths(searchParams);
    if (resolved.error) {
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
        return errorResponse(message, status === 404 ? 404 : 502);
    }

    // 文件名：repo-{ref}.zip 对齐 GitHub 官方命名；默认分支取实际命中的分支名
    const refLabel = resolved.label || hitCandidate.split("/").pop();

    const headers = {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${repo}-${refLabel}.zip"`,
    };
    // 透传 Content-Length 便于浏览器显示下载进度
    const contentLength = upstream.headers.get("Content-Length");
    if (contentLength) {
        headers["Content-Length"] = contentLength;
    }

    // 流式转发响应体，避免整体读入内存
    return new Response(upstream.body, { status: 200, headers });
}

/**
 * Worker 入口：静态资源之外的所有请求进入下载逻辑
 * @param {Request} request 请求对象
 * @returns {Response} 响应对象
 */
export default {
    async fetch(request) {
        const url = new URL(request.url);
        if (request.method !== "GET") {
            return errorResponse("仅支持 GET 请求", 405);
        }
        return handleDownload(request, url.pathname, url.searchParams);
    },
};
