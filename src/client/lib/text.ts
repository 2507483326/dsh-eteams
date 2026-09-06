/**
 * 文本判据复用件（docs/44 M7-9，46 清单）：角色列表搜索与壳侧栏 rail 筛选
 * 原是两份同款「大小写不敏感子串」判据，收口到这里避免漂移。
 *
 * @module dsh-eteams/client/text
 */

/**
 * 大小写不敏感子串判据（原两处同款三行的逐字收口）：haystack 任意位置含
 * query（query 先 trim 再小写化——空串/纯空白恒命中，两处原口径一致）。
 */
export function matchesQuery(haystack: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return haystack.toLowerCase().includes(q);
}