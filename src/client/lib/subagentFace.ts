/**
 * 子代理身份面的显隐决策与 tooltip 文案（用户迭代 2026-09-10「子代理隐藏团
 * 队按钮」）。独立成 lib 模块：teamsButton 本体牵着一串 UI 依赖（primitives
 * barrel 带 CSS、Radix 组件），node 单测拉不动；纯函数放这里才能被
 * tests/teamsButton.test.ts 直接锁定语义。
 *
 * @module dsh-eteams/client/subagentFace
 */
import type { SessionIdentity } from './api';

/**
 * 渲染决策（tests/teamsButton.test.ts 逐分支锁定）：已寻址子代理会话按身份
 * 三分——eteams 身份在册 = 'identity'（只读脸面：头像+名字）；无身份/身份
 * 失效/加载中 = 'hidden'（整个按钮隐藏——加载期同样不渲染，子代理会话上
 * 绝不闪出可交互按钮）；主会话 = 'interactive'（既有选择/锁定交互不变）。
 * isSubagent 由调用方先按轴解析（kit 快照 subagent 面 → eteams-label 会话
 * 快照探测兜底，sessionModelBadge 同款逐轴择源）。
 */
export function subagentFaceMode(
  isSubagent: boolean,
  identityReady: boolean,
  identity: SessionIdentity | null,
): 'identity' | 'hidden' | 'interactive' {
  if (!isSubagent) return 'interactive';
  return identityReady && identity !== null ? 'identity' : 'hidden';
}

/** 身份面 tooltip（静态串防闪烁——不随渲染变化）：按 kind 一句话说明。 */
export function subagentFaceTitle(identity: SessionIdentity): string {
  const teamSuffix = identity.teamName !== null ? `（团队「${identity.teamName}」）` : '';
  switch (identity.kind) {
    case 'member':
      return `成员「${identity.name}」的子代理会话${teamSuffix}`;
    case 'captain':
      return `领队「${identity.name}」的子代理会话${teamSuffix}`;
    case 'builder':
      return '角色构建师的子代理会话';
  }
}
