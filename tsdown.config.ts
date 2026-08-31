import { readFileSync } from 'node:fs';

const external = [/^@deepseek-ai\//, 'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'];

/**
 * 把 '@mdxeditor/editor/style.css' 改道为虚拟 JS 模块（字符串导出）。
 *
 * 为什么不走 tsdown 的 CSS 管线：宿主只加载单个 CJS envelope
 * （scripts/wrapClient.mjs），没有独立 CSS 通道；而 tsdown 在未安装
 * @tsdown/css 时对 .css id 无条件抛错（css-guard），moduleTypes 也绕不开
 * 它。虚拟模块 id 带 \0 前缀、不匹配 css-guard 的 /\.css$/ 过滤器，
 * 样式以字符串进包、运行时注入 <style>（见 src/client/mdEditor.tsx）。
 */
function mdxEditorCssInline() {
  // 虚拟 id 以 .js 结尾（rolldown 会把 \0 规范化成空格显示，css-guard 的
  // 过滤器按 id 后缀命中，带 .css 就会被拦）。
  const CSS_VIRTUAL_ID = '\0dsh-eteams:mdxeditor-style-css-js';
  // mdxeditor 的 CodeMirrorEditor 静态引入 language-data（仅 autoLoad 开启
  // 时才会用到，本项目已关闭）——它的 116 个按语言动态 import() 会把
  // 单文件 envelope 打碎成代码分块。stub 成空表，语言支持走下面的静态
  // 预载清单（mdEditor.tsx CODE_BLOCK_LANGUAGES）。
  const LANG_STUB_ID = '\0dsh-eteams:language-data-stub-js';
  // 上游发布缺陷：micromark-extension-highlight-mark 的 lib 里混入了
  // `import { ok as assert } from "uvu/assert"`（uvu 是测试框架）。uvu/diff
  // 模块顶层立即调用 kleur.dim()——在浏览器 CJS 互操作下必炸（TypeError），
  // 整个 client bundle 求值失败 → 插件客户端全灭 → 宿主进恢复模式。
  // highlight-mark 只服务 ==高亮== 语法，人设手册用不到——整链 stub 掉。
  const UVU_ASSERT_STUB_ID = '\0dsh-eteams:uvu-assert-stub-js';
  // 补丁缺陷修复：cordis 补丁版 CodeMirrorEditor.js 把 basicSetup 内联成
  // _eteamsHiLineGutter/_eteamsSynHi 等 14 个别名扩展，但没有写任何别名
  // 绑定——运行时一进代码块就 ReferenceError，被挂载 try/catch 吞掉后
  // 降级为纯文本编辑器（表现即「代码块无高亮」）。extensions 数组里本来
  // 就有 basicSetup + basicLight + 语言支持扩展，整体换回 ...extensions，
  // 功能一个不少且无重复。
  const CM_MOUNT_RE = /\.\.\.extensions\.filter\(\(x\) => x !== basicSetup\),\s*_eteamsHiLineGutter\(\),[\s\S]*?_eteamsHiSelMatches\(\)/;
  return {
    name: 'dsh-eteams:mdxeditor-css-inline',
    resolveId(id: string) {
      if (id === '@mdxeditor/editor/style.css') return CSS_VIRTUAL_ID;
      if (id === '@codemirror/language-data') return LANG_STUB_ID;
      if (id === 'uvu/assert' || id === 'uvu') return UVU_ASSERT_STUB_ID;
      return null;
    },
    transform(code: string, id: string) {
      if (!id.replace(/\\/g, '/').includes('@mdxeditor/editor/dist/plugins/codemirror/CodeMirrorEditor.js')) {
        return null;
      }
      if (!CM_MOUNT_RE.test(code)) return null;
      return code.replace(CM_MOUNT_RE, '...extensions');
    },
    load(id: string) {
      if (id === CSS_VIRTUAL_ID) {
        const css = readFileSync(
          new URL('./node_modules/@mdxeditor/editor/dist/style.css', import.meta.url),
          'utf8',
        );
        return `export default ${JSON.stringify(css)};`;
      }
      if (id === LANG_STUB_ID) {
        return 'export const languages = [];';
      }
      if (id === UVU_ASSERT_STUB_ID) {
        return 'export const ok = () => {}; export default { ok };';
      }
      return null;
    },
  };
}

export default [
  {
    entry: { index: 'src/host/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    external,
    dts: false,
    sourcemap: false,
    clean: false,
    outExtensions: () => ({ js: '.js' }),
  },
  {
    // CJS output drops into the ModuleLoader envelope verbatim: the wrapper
    // (scripts/wrapClient.mjs) provides `module`/`exports`/`require`.
    // 输出到 client.stage.js 暂存名：wrapClient 包好后原子 rename 成
    // client.js——运行中的宿主永远只会看到完整 envelope，不会 serve 到
    // 裸 CJS 中间态（那会炸渲染面：exports is not defined / 重复声明）。
    entry: { 'client.stage': 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    external,
    dts: false,
    sourcemap: false,
    clean: false,
    outExtensions: () => ({ js: '.js' }),
    plugins: [mdxEditorCssInline()],
    // lexical 的 default 分支（.mjs）带 top-level await（运行时在 dev/prod
    // 间二选一），CJS 输出不支持 TLA。rolldown 对 import 语句默认用
    // ["import","node","default"] 解析 exports——'node' 命中 @lexical/react
    // 的 .node.mjs（带 TLA）。经 inputOptions 给 conditionNames 显式加
    // 'production'：嵌套条件表里 production 键在 node 之前，先命中无 TLA
    // 的 .prod.mjs。define 兜底散落的 process.env。
    //（tsdown 对 CJS 强制 platform:'node'；字段名是 conditionNames，
    // 且必须走 inputOptions 通道——见 tsdown dist build.mjs:565/584。）
    define: { 'process.env.NODE_ENV': '"production"' },
    // 兜底：任何残余动态 import 一律内联进单文件，禁止代码分块
    //（envelope 只加载 lib/client.js 一个文件）。
    outputOptions: { inlineDynamicImports: true },
    inputOptions: {
      resolve: {
        conditionNames: ['production', 'import', 'require', 'module', 'browser', 'default'],
      },
    },
  },
];
