/**
 * 错误规范化与 busy/error 壳复用件（docs/44 M7-5，46 清单）：全仓 ~30 处
 * 「`e instanceof Error ? e.message : String(e)`」错误规范化与 15+ 处
 * 「置 busy → 清错 → await → 失败落错 → finally 复位 busy」提交壳收口到这里，
 * 避免第二份实现漂移。
 *
 * 边界：store model 的 dva effects（build/roster）catch 后还要 `put` 再
 * `throw`，generator 语义不经本件（只借 errorMessageOf 规范化）；error 槽是
 * 对象（tasks 页按卡定位的 `{ taskId, message }`）或 catch/finally 带额外
 * 动作（清购物车、回拉快照）的壳不强行套 runWithBusy——只借 errorMessageOf，
 * 见各消费位注记。
 *
 * @module dsh-eteams/client/errors
 */

/** 任意抛出值 → 展示文案：Error 取 message，其余 String()（原全仓同款
 * 三元的逐字收口；诊断面 recordClientDiag 与表单错误槽共用同一口径）。 */
export function errorMessageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * busy/error 提交壳（原各页 `setBusy(true); setError(null); try { await …
 * 成功侧效果 } catch { setError(原文) } finally { setBusy(false) }` 的逐字
 * 收口）：run 内承载全部成功侧效果（关弹窗/清表单/导航/回拉快照），失败以
 * errorMessageOf 落错、成功与否都复位 busy。守卫（busy 中/表单校验）留在
 * 调用点——壳只管 bookkeeping，不改变守卫时机。
 */
export async function runWithBusy(
  run: () => Promise<void>,
  setBusy: (busy: boolean) => void,
  setError: (message: string | null) => void,
): Promise<void> {
  setBusy(true);
  setError(null);
  try {
    await run();
  } catch (e) {
    setError(errorMessageOf(e));
  } finally {
    setBusy(false);
  }
}