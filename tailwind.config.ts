import type { Config } from 'tailwindcss';
import tailwindcssAnimate from 'tailwindcss-animate';

/**
 * Tailwind 配置（docs/21-client-ui-stack.md D19a/D19b）。
 *
 * - content 只扫 src/client 源码（绝不指向构建产物）；扫描是「正则提取完整
 *   类名字符串」——拼接/插值类名（`tone-${x}`）检测不到，动态样式一律用完整
 *   字面量映射表。
 * - preflight 必须为 false：客户端打成单文件 CJS envelope 注入宿主页面，
 *   全局 reset 绝不能溢进宿主 DOM。
 * - important: '.eteams-ui'：生成的工具类形如 `.eteams-ui .flex`，双向隔离
 *   （宿主样式进不来、客户端工具类溢不出去）。每个 React 表面根元素必须挂
 *   `className="eteams-ui"` 字面量，否则 content 扫描不到该选择器、purge
 *   会清空产物。
 * - theme.extend.colors 留空占位：S3 才落 token 桥（附录 A：shadcn 语义
 *   token 别名宿主 --dsw-* 变量；宿主变量是完整色值，禁用 /alpha 修饰）。
 * - plugins 先只挂 tailwindcss-animate（v3 侧 shadcn 动画类标准件）。
 */
const config: Config = {
  content: ['src/client/**/*.{ts,tsx}'],
  corePlugins: {
    preflight: false,
  },
  important: '.eteams-ui',
  theme: {
    extend: {
      // colors：S3 落地（docs/21 附录 A：shadcn token ↔ 宿主变量映射表）。
    },
  },
  plugins: [tailwindcssAnimate],
};

export default config;
