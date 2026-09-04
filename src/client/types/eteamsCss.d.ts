declare module '*.gen.css' {
  /** Tailwind 构建产物（scripts/buildTailwind.mjs → lib/tailwind.gen.css），经 tsdown tailwindCssInline 虚拟模块以字符串载入；S2 起 src/client/lib/tailwind.ts 消费并运行时注入。 */
  const css: string;
  export default css;
}
