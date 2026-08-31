/**
 * Envelope 冒烟测试：在 Node 里模拟宿主 ModuleLoader 加载 lib/client.js。
 * 验证：语法可解析、factory 顶层可执行、导出含 apply/inject。
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
  if (id === 'react' || id === 'react/jsx-runtime' || id === 'react-dom' || id === 'react-dom/client') {
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
console.log(`SMOKE OK: id=${loaded.id}, exports=[${exportsShape.join(', ')}]`);
