/**
 * Envelope 冒烟测试：在 Node 里模拟宿主 ModuleLoader 加载 lib/client.js。
 * 验证：语法可解析、factory 顶层可执行、导出含 apply/inject；并断言 Tailwind
 * 内联链路（注入锚点 data-dsh-eteams-tw + lib/tailwind.gen.css 非空且含
 * `.eteams-ui` 作用域选择器，R1-F4 / docs/21 21.8 首位风险门禁）。
 * 用法：node scripts/smokeEnvelope.mjs
 *
 * 装置说明：bundle 顶层有几处浏览器环境触点（decode-named-character-reference
 * 的 dom 变体、kleur 类探测、@codemirror/view 的浏览器检测、react-dom 顶层
 * 事件支持探测）——这里给最小 DOM stub；react-dom 走生产构建（真实宿主注入
 * 的也是生产版）；@deepseek-ai/* 用服务 stub（真实宿主注入预构建 bundle）。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';

// react-dom 的 require 必须拿生产构建（development 版模块顶层就探测 DOM 事件支持）。
process.env.NODE_ENV = 'production';

const clientPath = new URL('../lib/client.js', import.meta.url);
const code = readFileSync(clientPath, 'utf8');

const fakeElement = {
  innerHTML: '',
  textContent: '',
  style: {},
  setAttribute: () => {},
  getAttribute: () => null,
  addEventListener: () => {},
  removeEventListener: () => {},
};

const documentStub = {
  createElement: () => ({ ...fakeElement }),
  createTextNode: () => ({ nodeType: 3 }),
  head: { appendChild: () => {} },
  body: { hasAttribute: () => false, style: {} },
  documentElement: { style: {} },
  hidden: false,
  addEventListener: () => {},
  removeEventListener: () => {},
};

const navigatorStub = {
  userAgent: 'node-smoke',
  vendor: 'Google Inc.',
  platform: 'Win32',
  maxTouchPoints: 0,
};

globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
};

const nodeRequire = createRequire(new URL('..', import.meta.url).href);
const loaderRequire = (id) => {
  // react 系真实加载（bundle 顶层会用到 JSX runtime 等）。
  if (
    id === 'react' ||
    id === 'react/jsx-runtime' ||
    id === 'react-dom' ||
    id === 'react-dom/client'
  ) {
    return nodeRequire(id);
  }
  // @deepseek-ai/* 返回轻量 stub：宿主真实注入的是预构建 bundle（不含裸
  // CSS require），Node 直读源码会撞 .module.css——冒烟只验证 factory 可
  // 执行与导出形状，不需要真实服务实现。
  if (id.startsWith('@deepseek-ai/')) {
    return new Proxy(function dshServiceStub() {}, {
      get: (_t, prop) => (prop === Symbol.toPrimitive ? undefined : function stub() {}),
      apply: () => ({}),
    });
  }
  throw new Error(`smoke: unexpected external require(${JSON.stringify(id)})`);
};

let loaded = null;
const windowStub = {
  __ModuleLoader__: {
    load({ id, factory }) {
      loaded = { id, exports: factory(loaderRequire) };
    },
  },
  document: documentStub,
  navigator: navigatorStub,
  location: { href: 'http://127.0.0.1:43120/' },
  addEventListener: () => {},
  removeEventListener: () => {},
  MutationObserver: globalThis.MutationObserver,
};
globalThis.document = documentStub;

try {
  // CJS envelope 以 window 为全局入口，用 Function 在受控作用域求值。
  new Function('window', 'navigator', 'document', 'MutationObserver', code)(
    windowStub,
    navigatorStub,
    documentStub,
    globalThis.MutationObserver,
  );
} catch (error) {
  console.error('SMOKE FAIL (evaluation):', error?.stack ?? error);
  process.exit(1);
}

if (!loaded) {
  console.error('SMOKE FAIL: __ModuleLoader__.load was never called');
  process.exit(1);
}
const exportsShape = Object.keys(loaded.exports ?? {});
if (typeof loaded.exports?.apply !== 'function' || !Array.isArray(loaded.exports?.inject)) {
  console.error('SMOKE FAIL: exports shape unexpected:', exportsShape);
  process.exit(1);
}

// Tailwind 内联断言（R1-F4，docs/21 S1 合同「`.eteams-ui` 选择器断言自 S3 起」
// + 21.8 首位风险「动态类名被 purge → 样式静默缺失」的自动化门禁兜底）：
// 此前 smoke 只验证 exports 形状，envelope 是否真的内联了 Tailwind 产物、
// 作用域选择器是否真的生成，全靠事实通过没有门禁。三连断言，任一失败 exit 1：
// 1) envelope 源码含注入锚点 data-dsh-eteams-tw（tailwind.ts 的幂等键，
//    证明 ensureEteamsStyles 注入代码在包内）；
// 2) lib/tailwind.gen.css 非空；
// 3) 产物含 `.eteams-ui` 作用域选择器——token 桥块（.eteams-ui{--background:）
//    与代表工具类（.eteams-ui .flex）各一处，即 important:'.eteams-ui' 真实
//    生效、purge 没有清空产物。
const TW_STYLE_ATTRIBUTE = 'data-dsh-eteams-tw';
if (!code.includes(TW_STYLE_ATTRIBUTE)) {
  console.error(
    `SMOKE FAIL: envelope missing ${TW_STYLE_ATTRIBUTE} anchor — Tailwind 注入代码未进包（tailwindCssInline 虚拟模块失效？）`,
  );
  process.exit(1);
}
const genCssPath = new URL('../lib/tailwind.gen.css', import.meta.url);
let genCss;
try {
  genCss = readFileSync(genCssPath, 'utf8');
} catch {
  console.error('SMOKE FAIL: lib/tailwind.gen.css 读取失败——先运行 node scripts/buildTailwind.mjs');
  process.exit(1);
}
if (genCss.length === 0) {
  console.error('SMOKE FAIL: lib/tailwind.gen.css is empty — Tailwind 产物异常，拒绝放行');
  process.exit(1);
}
for (const selector of ['.eteams-ui{--background:', '.eteams-ui .flex']) {
  if (!genCss.includes(selector)) {
    console.error(
      `SMOKE FAIL: lib/tailwind.gen.css missing scoped selector ${JSON.stringify(selector)} — purge 清空或 important:'.eteams-ui' 失效`,
    );
    process.exit(1);
  }
}
console.log(`SMOKE OK: id=${loaded.id}, exports=[${exportsShape.join(', ')}]`);
