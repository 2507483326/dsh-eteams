/**
 * 抓取 mdxeditor 官方文档三篇（入门/代码块/主题）到本地缓存。
 *
 * 为什么不用 Invoke-WebRequest / curl：本机 schannel 在该环境
 * AcquireCredentialsHandle 失败（SEC_E_NO_CREDENTIALS），TLS 客户端不可用；
 * Node 走自带 OpenSSL，直连正常。以后抓文档一律走本脚本或 node fetch。
 */
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const pages = {
  'getting-started': 'https://mdxeditor.dev/',
  'code-blocks': 'https://mdxeditor.dev/editor/docs/code-blocks',
  'theming': 'https://mdxeditor.dev/editor/docs/theming',
};

mkdirSync(OUT, { recursive: true });

/** <article> 正文抽取：pre → 围栏码块，其余标签剥掉，实体还原。 */
function extractArticle(html) {
  const m = html.match(/<article[^>]*>([\s\S]*?)<\/article>/);
  let body = m ? m[1] : html;
  body = body
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<nav[\s\S]*?<\/nav>/g, '')
    .replace(/<(pre|pre\s+[^>]*)>/g, '\n```\n')
    .replace(/<\/pre>/g, '\n```\n')
    .replace(/<(br|br\/|br\s+\/)>/g, '\n')
    .replace(/<\/(p|div|li|h1|h2|h3|h4|h5|h6|tr|table|section)>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n');
  return body.trim();
}

for (const [name, url] of Object.entries(pages)) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(30000),
      headers: { 'user-agent': 'Mozilla/5.0 (docs fetcher)' },
    });
    const html = await res.text();
    writeFileSync(`${OUT}${name}.html`, html, 'utf8');
    writeFileSync(`${OUT}${name}.txt`, extractArticle(html), 'utf8');
    console.log(`${name}: HTTP ${res.status}, html ${html.length} chars -> ${name}.html/.txt`);
  } catch (error) {
    console.error(`${name}: FAILED ${error?.message ?? error}`);
  }
}
