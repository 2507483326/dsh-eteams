const external = [/^@deepseek-ai\//, 'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'];

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
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    external,
    dts: false,
    sourcemap: false,
    clean: false,
    outExtensions: () => ({ js: '.js' }),
  },
];
