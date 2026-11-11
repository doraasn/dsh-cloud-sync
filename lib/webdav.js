/**
 * 极简 WebDAV 客户端，只用 node:https / node:http；对坚果云、Nextcloud、群晖等常见实现兼容。
 *
 * 只实现插件需要的动作：PROPFIND(列目录) / MKCOL(建目录) / PUT / GET / DELETE / HEAD。
 * 认证用 HTTP Basic；口令不落任何文件、不进日志。
 */
import http from 'node:http';
import https from 'node:https';

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop>
<d:displayname/><d:getcontentlength/><d:getlastmodified/><d:resourcetype/><d:getetag/>
</d:prop></d:propfind>`;

export class WebDavError extends Error {
  constructor(message, { method, url, status, body } = {}) {
    super(message);
    this.name = 'WebDavError';
    this.method = method;
    this.url = url;
    this.status = status;
    this.body = body;
  }
}

function joinUrl(base, path) {
  const left = base.replace(/\/+$/, '');
  const right = String(path ?? '').replace(/^\/+/, '');
  return right ? `${left}/${right}` : `${left}/`;
}

/** 统一成「去掉尾部斜杠再加一个」的形式，用于比较 DAV 自身条目。 */
function normalizePath(value) {
  return decodeURIComponent(value).replace(/\/+$/, '') + '/';
}

/** 从 XML 里抠出 response 块（命名空间前缀不固定，用宽松匹配）。 */
function parseMultiStatus(xml) {
  const entries = [];
  const blocks = xml.split(/<(?:\w+:)?response[\s>]/i).slice(1);
  for (const block of blocks) {
    const hrefMatch = block.match(/<(?:\w+:)?href[^>]*>([\s\S]*?)<\/(?:\w+:)?href>/i);
    if (!hrefMatch) continue;
    const href = hrefMatch[1].trim();
    const isDir = /<(?:\w+:)?collection\s*\/?>/i.test(block);
    const sizeMatch = block.match(/<(?:\w+:)?getcontentlength[^>]*>(\d+)<\//i);
    const modMatch = block.match(/<(?:\w+:)?getlastmodified[^>]*>([^<]+)<\//i);
    entries.push({
      href,
      name: decodeURIComponent(href.replace(/\/+$/, '').split('/').pop() ?? ''),
      dir: isDir,
      size: sizeMatch ? Number(sizeMatch[1]) : 0,
      lastModified: modMatch ? modMatch[1] : null,
    });
  }
  return entries;
}

export class WebDavClient {
  /** @param {{baseUrl:string, username:string, password:string, timeoutMs?:number, logger?:object}} options */
  constructor({ baseUrl, username, password, timeoutMs = 30000, uploadTimeoutMs = 300000, logger } = {}) {
    if (!baseUrl) throw new Error('WebDAV baseUrl 未配置');
    this.baseUrl = baseUrl;
    this.username = username ?? '';
    this.password = password ?? '';
    this.timeoutMs = timeoutMs;
    // 上传用的空闲超时：坚果云会限速，73MB 的 PUT 中途可能几十秒没有任何数据流动
    this.uploadTimeoutMs = Math.max(timeoutMs, Number(uploadTimeoutMs) || 300000);
    this.logger = logger ?? null;
    this.auth = 'Basic ' + Buffer.from(`${this.username}:${this.password}`, 'utf8').toString('base64');
  }

  request(method, path, { body, headers = {}, timeoutMs, maxBytes = 256 * 1024 * 1024 } = {}) {
    const url = joinUrl(this.baseUrl, path);
    const target = new URL(url);
    const transport = target.protocol === 'http:' ? http : https;

    return new Promise((resolve, reject) => {
      const req = transport.request(
        {
          method,
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || undefined,
          path: target.pathname + target.search,
          headers: {
            Authorization: this.auth,
            'User-Agent': 'dsh-cloud-sync',
            ...headers,
          },
          timeout: timeoutMs ?? this.timeoutMs,
        },
        (res) => {
          const chunks = [];
          let size = 0;
          res.on('data', (chunk) => {
            size += chunk.length;
            // 对端可以返回任意大的 body（甚至无限流）：超限直接断开，别攒进内存。
            if (size > maxBytes) {
              req.destroy(new WebDavError(`响应体超过上限（${maxBytes} 字节）`, { method, url }));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
          );
        },
      );
      req.on('timeout', () => req.destroy(new Error(`WebDAV 请求超时（${method} ${url}）`)));
      req.on('error', (err) => reject(new WebDavError(`${method} ${url} 失败：${err.message}`, { method, url })));
      if (body) req.write(body);
      req.end();
    });
  }

  async ensureOk(method, path, options, okStatuses) {
    const res = await this.request(method, path, options);
    if (!okStatuses.includes(res.status)) {
      const text = res.body.subarray(0, 300).toString('utf8');
      throw new WebDavError(`${method} ${joinUrl(this.baseUrl, path)} 返回 ${res.status}${text ? `：${text}` : ''}`, {
        method,
        url: joinUrl(this.baseUrl, path),
        status: res.status,
        body: text,
      });
    }
    return res;
  }

  /** 列一层目录；目录不存在时返回 null（常见实现缺路径回 404）。 */
  async list(path = '') {
    const res = await this.request('PROPFIND', path, { headers: { Depth: '1', 'Content-Type': 'application/xml' }, body: PROPFIND_BODY });
    if (res.status === 404) return null;
    if (res.status !== 207 && res.status !== 200) {
      throw new WebDavError(`PROPFIND 返回 ${res.status}`, { method: 'PROPFIND', status: res.status, body: res.body.subarray(0, 300).toString('utf8') });
    }
    // DAV 的 href 可能是绝对路径也可能是完整 URL，统一成 pathname 再排除自身
    const selfPath = normalizePath(new URL(joinUrl(this.baseUrl, path)).pathname);
    return parseMultiStatus(res.body.toString('utf8')).filter((entry) => {
      const hrefPath = normalizePath(entry.href.startsWith('http') ? new URL(entry.href).pathname : entry.href);
      return hrefPath !== selfPath;
    });
  }

  /** 逐级 MKCOL；已存在（405/301）视为成功。 */
  async ensureDir(path) {
    const parts = String(path ?? '').split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const res = await this.request('MKCOL', current);
      if (![201, 200, 204, 301, 302, 405].includes(res.status)) {
        throw new WebDavError(`MKCOL ${current} 返回 ${res.status}`, { method: 'MKCOL', status: res.status });
      }
    }
  }

  /**
   * 上传一个文件。大包会用到更长的空闲超时，并在超时/连接被重置时自动重试一次。
   * @param {string} path 远端路径
   * @param {Buffer} body 内容
   * @param {{timeoutMs?: number, retries?: number}} [options]
   */
  async put(path, body, { timeoutMs, retries = 1 } = {}) {
    const idle = timeoutMs ?? this.uploadTimeoutMs;
    const headers = { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length) };
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        await this.ensureOk('PUT', path, { body, headers, timeoutMs: idle }, [200, 201, 204]);
        return;
      } catch (err) {
        lastErr = err;
        // 只对超时/连接层错误重试；4xx（如流量超限）重试也没用
        const retriable = !err?.status || err.status >= 500;
        if (!retriable || attempt === retries) break;
        await new Promise((resolve) => setTimeout(resolve, 2000));
        this.logger?.warn?.('[cloud-sync] 上传重试（第 %d 次）：%s', attempt + 2, err?.message ?? err);
      }
    }
    throw lastErr;
  }

  async get(path) {
    const res = await this.ensureOk('GET', path, {}, [200, 206]);
    return res.body;
  }

  async head(path) {
    const res = await this.request('HEAD', path);
    if (res.status === 404) return null;
    return { status: res.status, size: Number(res.headers['content-length'] ?? 0), lastModified: res.headers['last-modified'] ?? null };
  }

  async remove(path) {
    await this.ensureOk('DELETE', path, {}, [200, 202, 204, 404]);
  }
}
