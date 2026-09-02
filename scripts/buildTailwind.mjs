/**
 * Tailwind 构建步（docs/21-client-ui-stack.md D19a）：tailwind CLI 生成 lib/tailwind.gen.css。
 * CLI 产出后追加字体前置步（docs/24 D22b）：fontsource variable 的 latin woff2
 * base64 成 @font-face 写回产物文件头（台账打印字节数）。
 *
 * pnpm build 串步位置：tsc(client) 之后、tsdown 之前——tsdown 的
 * tailwindCssInline 虚拟模块在打包时把该产物以字符串内联进单文件 CJS envelope。
 * 产物已 gitignore（/lib 整体忽略 + 显式补条目自文档化）。
 *
 * node 可执行文件选取：优先 process.execPath（常规环境它就是 node 本体）。
 * 但在 DSH 桌面沙箱里，pnpm 脚本的 node 是 ELECTRON_RUN_AS_NODE 包装，
 * process.execPath 指向 DSH Desktop.exe——不带该环境变量直接 spawn 会进
 * GUI 模式静默空转（exit 0、零输出、不产文件）。故两个候选（execPath、
 * PATH 上的 node）都先做一次 `-e` 探针，能真实执行 JS 的才可信；再配
 * 合产物存在性自校验，杜绝「spawn 成功但什么都没干」的假绿。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

// 仓库根（本脚本上一级）：spawn 的 cwd 锚定在此，相对路径不受调用方 cwd 影响。
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const outputFile = 'lib/tailwind.gen.css';

/** 探针：该候选能否真实执行 JS（DSH Desktop.exe 的 GUI 模式会在此现形）。 */
function canRunJs(candidate) {
  const probe = spawnSync(candidate, ['-e', 'process.stdout.write("ok")'], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (probe.error?.code === 'EPERM') {
    // DSH 桌面沙箱禁止子进程管道 stdio（PowerShell 管道不受影响，但
    // Node spawnSync 默认 pipe 必被拒）。退化成纯退出码探针：GUI 模式
    // 「exit 0 却什么都不干」的假成功由下方产物存在性自检兜底拒绝。
    const bare = spawnSync(candidate, ['-e', 'process.exit(0)'], {
      stdio: 'ignore',
      timeout: 15_000,
    });
    return bare.status === 0;
  }
  return probe.status === 0 && probe.stdout === 'ok';
}

function resolveNodeBinary() {
  const candidates = [process.execPath, 'node'];
  for (const candidate of candidates) {
    if (canRunJs(candidate)) return candidate;
  }
  console.error(
    `[buildTailwind] 找不到可用的 node 可执行文件（候选：${candidates.join('、')}）。请确认 node 已安装且在 PATH 上。`,
  );
  process.exit(1);
}

/*
 * 字体打包（docs/24 D22b，翻案 D20b「不打包字体」）：fontsource variable 包的
 * latin 子集 woff2 → base64 → @font-face 块前置进 gen.css。客户端打成单文件
 * envelope、无独立 CSS 通道，字体文件必须内联；体积台账预算 ≤ +260KB。
 * latin 子集足够（官网同款行为：CJK 落系统字体）；@font-face 字段以
 * fontsource 官方 index.css 为准（unicode-range 原样保留 latin 档，区间外
 * 字符立即回落字体栈，不白等）；font-display 按合同取 block——data URI 无
 * 网络往返，swap/block 差异只剩解码瞬间，block 防回退字闪替。
 */
const FONT_EMBEDS = [
  {
    file: 'node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
    family: 'Inter Variable',
    weight: '100 900',
    unicodeRange:
      'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
  },
  {
    file: 'node_modules/@fontsource-variable/fira-code/files/fira-code-latin-wght-normal.woff2',
    family: 'Fira Code Variable',
    weight: '300 700',
    unicodeRange:
      'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
  },
];

/** 读 latin woff2 → 拼 @font-face 块（字段顺序照 fontsource index.css）。 */
function buildFontFaceCss() {
  const blocks = [];
  for (const font of FONT_EMBEDS) {
    let woff2;
    try {
      woff2 = readFileSync(repoRoot + font.file);
    } catch {
      console.error(
        `[buildTailwind] 字体文件缺失：${font.file}（@fontsource-variable devDeps 未安装？）`,
      );
      process.exit(1);
    }
    console.log(`[buildTailwind] 字体 ${font.family}：${woff2.length} B（latin woff2，base64 前）`);
    blocks.push(
      `@font-face {\n` +
        `  font-family: '${font.family}';\n` +
        `  font-style: normal;\n` +
        `  font-display: block;\n` +
        `  font-weight: ${font.weight};\n` +
        `  src: url(data:font/woff2;base64,${woff2.toString('base64')}) format('woff2-variations');\n` +
        `  unicode-range: ${font.unicodeRange};\n` +
        `}`,
    );
  }
  return blocks.join('\n') + '\n';
}

let cliPath;
try {
  cliPath = require.resolve('tailwindcss/lib/cli.js');
} catch (error) {
  console.error('[buildTailwind] 无法解析 tailwindcss/lib/cli.js（tailwindcss 未安装？）');
  throw error;
}

const nodeBinary = resolveNodeBinary();

const result = spawnSync(
  nodeBinary,
  [
    cliPath,
    '-c',
    'tailwind.config.ts',
    '-i',
    'src/client/eteams.css',
    '-o',
    outputFile,
    '--minify',
  ],
  // stdio ignore：沙箱下 pipe 会 EPERM；CLI 的产出是文件不是 stdout，
  // 产物存在性自检兜底，无信息损失。
  { cwd: repoRoot, stdio: 'ignore' },
);

if (result.error) {
  console.error(`[buildTailwind] spawn 失败：${result.error.message}`);
  process.exit(1);
}

// 退出码透传（被信号杀死时 status 为 null → 按 1 报败）。
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

// 产物自校验：CLI 假绿（exit 0 却没写文件）时显式报败，不让管线静默通过。
if (!existsSync(repoRoot + outputFile)) {
  console.error(
    `[buildTailwind] tailwind CLI 退出码为 0 但未产出 ${outputFile}——构建环境异常，拒绝放行。`,
  );
  process.exit(1);
}

// 字体前置（D22b）：CLI 产出后读 latin woff2 → base64 @font-face 写回文件头。
// 直接覆写产物（产物本身 gitignore，@font-face 无需再过 CLI/tailwind 处理）。
const generatedCss = readFileSync(repoRoot + outputFile, 'utf8');
const fontFaceCss = buildFontFaceCss();
writeFileSync(repoRoot + outputFile, fontFaceCss + generatedCss);
console.log(
  `[buildTailwind] ${outputFile}：${Buffer.byteLength(generatedCss)} B → ${Buffer.byteLength(fontFaceCss + generatedCss)} B（前置字体 base64）`,
);
