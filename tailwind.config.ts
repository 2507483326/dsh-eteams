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
 *   `var(--token)`（token 定义在 src/client/eteams.css 的 @layer base，
 *   别名宿主 --dsw-alias-* 变量）。宿主变量是完整色值，不用 hsl(var())
 *   通道形式；token 色禁用 /alpha 修饰（需要半透明走专用 token/color-mix）。
 *   success/warning/business 为扩展 token，服务 Tone 徽标语义。
 * - borderRadius 按 shadcn v3 惯例从 --radius 衍生（--radius: 0.75rem，
 *   对齐 card.tsx 现行 12px）。
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
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
    },
  },
  plugins: [tailwindcssAnimate],
};

export default config;
