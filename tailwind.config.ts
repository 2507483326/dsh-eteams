import type { Config } from 'tailwindcss';
import tailwindcssAnimate from 'tailwindcss-animate';

/**
 * Tailwind 配置（docs/21-client-ui-stack.md D19a/D19b/D19c）。
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
 * - theme.extend.colors（S3，附录 A）：shadcn 语义 token 全部映射
 *   `var(--token)`（token 定义在 src/client/styles/eteams.css 的 @layer base）。
 *   token 值为完整色值，不用 hsl(var())
 *   通道形式；token 色禁用 /alpha 修饰（需要半透明走专用 token/color-mix）。
 *   success/warning/business 为扩展 token，服务 Tone 徽标语义。
 *   值口径（docs/24 D22a，翻案 D21a/D21d）：token 值为 tailwindcss.cn v3
 *   官网字面值（slate 灰阶 + sky 强调），不再桥接宿主 --dsw-alias-*；暗色经
 *   祖先选择器 body[data-ds-dark-theme] .eteams-ui 切官网暗色（eteams.css
 *   内双块同名定义）。**刻意不配置 darkMode**：暗色不走 dark: 变体（D22a
 *   不变式），工具类层无需感知暗色。
 * - borderRadius 按 shadcn v3 惯例从 --radius 衍生（--radius: 0.75rem，
 *   对齐 card.tsx 现行 12px）。
 * - plugins 先只挂 tailwindcss-animate（v3 侧 shadcn 动画类标准件）。
 * - fontFamily（docs/22 D20b / docs/24 D22b 翻案打包决策）：font-sans/
 *   font-mono 消费 eteams.css 的 --eteams-font-sans/-mono 字体栈令牌——
 *   'Inter Variable' / 'Fira Code Variable'（@fontsource-variable latin
 *   woff2 由 buildTailwind.mjs base64 打包进 gen.css）打头，系统兜底栈在后。
 */
const config: Config = {
  content: ['src/client/**/*.{ts,tsx}'],
  corePlugins: {
    preflight: false,
  },
  important: '.eteams-ui',
  theme: {
    extend: {
      fontFamily: {
        sans: 'var(--eteams-font-sans)',
        mono: 'var(--eteams-font-mono)',
      },
      colors: {
        border: 'var(--border)',
        input: 'var(--input)',
        ring: 'var(--ring)',
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        primary: {
          DEFAULT: 'var(--primary)',
          foreground: 'var(--primary-foreground)',
        },
        secondary: {
          DEFAULT: 'var(--secondary)',
          foreground: 'var(--secondary-foreground)',
        },
        destructive: {
          DEFAULT: 'var(--destructive)',
          foreground: 'var(--destructive-foreground)',
        },
        muted: {
          DEFAULT: 'var(--muted)',
          foreground: 'var(--muted-foreground)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          foreground: 'var(--accent-foreground)',
        },
        popover: {
          DEFAULT: 'var(--popover)',
          foreground: 'var(--popover-foreground)',
        },
        card: {
          DEFAULT: 'var(--card)',
          foreground: 'var(--card-foreground)',
        },
        // 扩展 token（超出 shadcn 标准集，服务 Tone 徽标语义）
        success: {
          DEFAULT: 'var(--success)',
        },
        warning: {
          DEFAULT: 'var(--warning)',
        },
        business: {
          DEFAULT: 'var(--business)',
          // 品牌淡底对（docs/24 D22a：官网 sky 淡底），chips/选中底用。
          tint: 'var(--business-tint)',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      // shadcn Accordion（components/ui/accordion.tsx）展开/收起动画（上游
      // new-york 标配，高度以 Radix 注入的 --radix-accordion-content-height
      // 测量值驱动）。v3 手动安装的标准一步。
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [tailwindcssAnimate],
};

export default config;
