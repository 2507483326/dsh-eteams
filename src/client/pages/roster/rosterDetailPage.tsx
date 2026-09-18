/**
 * 角色详情编辑页（docs/13.3 角色 / docs/19.6.2 构建师播报联动）：名称/头像/
 * 手册一处编辑——自 membersTab 拆出（docs/44 M2，行为零变更），路由
 * /roster/:name，:name 路由参数即角色名（react-router 自动解码；改名成功
 * 换参导航，详情跟随新名）。用户迭代 2026-09-18：去掉汇报记录（原成员汇报
 * 时间线 MemberDialog 及其取数上下文 team 撤；页内只剩名称/头像/手册一处
 * 编辑）。
 *
 * The role detail handbook (用户反馈：去掉人设摘要，全部提炼到角色手册).
 * 用户迭代 2026-09-03：编辑钮挪到详情页头，名称/头像/手册一处编辑——保存
 * 走 POST /roster 整条 upsert（host 替换整个条目，现有字段全量重发）；
 * 领队经宿主 allowLeader 放行同样可编辑（名称仍为系统保留）。改名 =
 * 保存新名 + 删除旧条目（保留角色名称锁死，不改名）。
 *
 * @module dsh-eteams/client/pages/roster/rosterDetailPage
 */
import { useState, type ReactNode } from 'react';
import { useDispatch } from 'react-redux';
import { useNavigate, useParams } from 'react-router-dom';
import PenLine from 'lucide-react/dist/esm/icons/pen-line.mjs';
import type { RosterMember } from '../../lib/api';
import { cn } from '../../lib/cn';
import { errorMessageOf } from '../../lib/errors';
import { ROSTER_DETAIL_SUBTITLE_META } from '../../lib/status';
import { MdEditor } from '../../features/mdEditor/mdEditor';
import { Avatar } from '../../features/avatar/avatar';
import { RandomAvatarButton, rollAvatarPair } from '../../components/avatarRing';
import { FormFooterActions } from '../../components/formDialog';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { handbookSeed } from './buildDraft';
import { MarkdownDoc } from '../shared/markdownDoc';
import { FormErrorNote } from '../shared/components';
import {
  LEADER_NAME,
  MUTED_CLASS,
  PANEL_CARD_CLASS,
  PROTECTED_MEMBERS,
  SECTION_TITLE_CLASS,
} from '../shared/styles';
import { useBuildSession } from './buildWorkbench';

/** ================================== 类型 ================================== */

/** 路由页入参（壳状态经 routes.tsx 传入，数据流与拆分前逐位一致）。 */
export interface RosterDetailPageProps {
  /** 角色库（:name 查条目 + 改名重名拦截，store roster.list 经壳传入）。 */
  members: RosterMember[];
  /** 保存/改名回拉（roster/fetchRoster）。 */
  onDeleted: () => void;
}

/** ================================== 主组件 ================================== */

/** 详情手册文本（v12）：主对话注入角色用原文（注入内容逐字等于编辑文本），
 * 普通角色走 handbookSeed 脚手架兜底——isRoot 不兜底，空文保持空。 */
function detailHandbookText(detail: RosterMember): string {
  return detail.isRoot === true ? (detail.personaMd ?? '') : handbookSeed(detail);
}

/**
 * 角色详情：页头卡（头像环 + 名称/副注 + 编辑/保存/取消）+ 手册卡（编辑器/
 * 只读渲染）。编辑/只读切换观感与拆分前逐位一致。
 */
export function RosterDetailPage({ members, onDeleted }: RosterDetailPageProps): ReactNode {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  // :name 路由参数即角色名（react-router 自动解码）。
  const { name } = useParams();
  const detail = members.find((m) => m.name === name) ?? null;
  // 构建会话轮询照跑（「仅角色域活跃时轮询」现状保持）；待确认草稿到达时
  // 不再自动跳新增页（用户 2026-09-18），详情页原地不动。
  useBuildSession();

  // —— 角色详情编辑（用户迭代 2026-09-03）——
  // 编辑钮挪到详情页头：名称输入 + 随机头像 + 保存/取消一行收口，手册编辑
  // 器跟在页头卡下。领队/角色构建师同样可编辑（宿主对面板显式保存放行，
  // 见 roster.ts allowLeader）；仅名称锁死——领队名绑定团队领队卡、改用
  // 「新增角色」另建。改名 = 保存新名 + 删除旧条目（两步，非事务）。
  const [detailEditing, setDetailEditing] = useState(false);
  const [detailDraftName, setDetailDraftName] = useState('');
  // 一句话简介（用户迭代 2026-09-06）：编辑态随保存整条 upsert 落库。
  const [detailDraftProfile, setDetailDraftProfile] = useState('');
  const [detailDraftAvatar, setDetailDraftAvatar] = useState<{ seed: number; salt: number } | null>(
    null,
  );
  const [detailDraftMd, setDetailDraftMd] = useState('');
  const [detailSaving, setDetailSaving] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  /* —— 事件处理 —— */

  const startDetailEdit = (): void => {
    if (detail === null) return;
    setDetailDraftName(detail.name);
    setDetailDraftProfile(detail.profile ?? '');
    setDetailDraftAvatar(detail.avatar ?? null);
    setDetailDraftMd(detailHandbookText(detail));
    setDetailError(null);
    setDetailEditing(true);
  };
  const cancelDetailEdit = (): void => {
    setDetailEditing(false);
    setDetailError(null);
  };
  const rollDetailAvatar = (): void => {
    // 与宿主默认头像同口径：seed 0..996（hashName % 997）、salt 0..999。
    setDetailDraftAvatar(rollAvatarPair());
  };
  const saveDetail = (): void => {
    if (detail === null || detailSaving) return;
    const newName = detailDraftName.trim();
    if (newName === '') {
      setDetailError('角色名不能为空');
      return;
    }
    const nameLocked = PROTECTED_MEMBERS.includes(detail.name);
    const nameChanged = newName !== detail.name;
    if (nameChanged && members.some((m) => m.name === newName)) {
      setDetailError(`角色「${newName}」已存在，换个名字`);
      return;
    }
    setDetailSaving(true);
    setDetailError(null);
    void (async (): Promise<void> => {
      try {
        // 整条 upsert（host 替换整个条目）：现有字段全量重发，仅名称/头像/
        // 手册取草稿值。
        await dispatch({
          type: 'roster/saveRoster',
          payload: {
            name: newName,
            role: detail.role,
            ...(detailDraftProfile.trim() !== '' ? { profile: detailDraftProfile.trim() } : {}),
            ...(detail.duty !== undefined ? { duty: detail.duty } : {}),
            ...(detail.style !== undefined ? { style: detail.style } : {}),
            ...(detail.skills !== undefined ? { skills: detail.skills } : {}),
            ...(Array.isArray(detail.rules) ? { rules: detail.rules } : {}),
            ...(detail.executionPrompt !== undefined
              ? { executionPrompt: detail.executionPrompt }
              : {}),
            ...(detailDraftAvatar !== null ? { avatar: detailDraftAvatar } : {}),
            personaMd: detailDraftMd,
          },
        });
        if (nameChanged && !nameLocked) {
          // 改名 = 新条目已落库后移除旧条目；保留角色锁名不会走到这里。
          // 失败回滚（v3 角色行按名 upsert）：删旧名失败时把刚建的新条目删掉
          // 再报错，避免留下重复条目（新旧行同库共存会互相遮蔽）。
          try {
            await dispatch({ type: 'roster/deleteRoster', payload: detail.name });
          } catch (rollbackError) {
            try {
              await dispatch({ type: 'roster/deleteRoster', payload: newName });
            } catch {
              // 回滚失败尽力而为：以原错误为准上报
            }
            throw rollbackError;
          }
        }
        // 详情跟随新名（改名后停在详情页）：:name 路由参数即角色名——改名
        // 即换参（同路由换参不重挂，编辑态就地退出）。
        if (nameChanged) navigate(`/roster/${encodeURIComponent(newName)}`);
        setDetailEditing(false);
        onDeleted();
      } catch (e) {
        setDetailError(errorMessageOf(e));
      } finally {
        setDetailSaving(false);
      }
    })();
  };

  if (detail === null) {
    // 防御位：路由名在名册里找不到（改名保存后的名册回拉窗口 / 条目刚被
    // 删除）。拆分前该窗口回落到列表视图渲染，拆页后无对应落点，渲染空
    // 内容——名册回拉到位后详情即恢复（见 46 清单 M2 验收注记）。
    return null;
  }

  const isLeader = detail.name === LEADER_NAME;
  const nameLocked = PROTECTED_MEMBERS.includes(detail.name);
  // 头像：编辑态取草稿（随机头像实时预览），只读态取条目现值。
  const avatarPair =
    detailEditing && detailDraftAvatar !== null ? detailDraftAvatar : detail.avatar;
  return (
    // 版式：详情列不再限宽（用户要求解除固定宽度），面板全宽利用
    <div>
      {/* 返回钮走壳层页头 onBack（用户迭代 2026-09-08：页面返回统一收口
      PageHeader onBack 槽，页头行最右图标钮）——原 BackBar 文案钮撤：编辑中
      返回列表即丢弃草稿（原 cancelDetailEdit 收尾——页面卸载即弃，无需显
      式清），导航语义不变。 */}
      <Card className={cn(PANEL_CARD_CLASS)}>
        <div className="flex items-center gap-3.5">
          {/* 头像（描边环已撤——用户迭代 2026-09-07，描边统一走 Avatar
          默认 1px 深灰框、白底、无间隔）；编辑态头像下挂「随机头像」钮
          （用户迭代 2026-09-03）。 */}
          <div className="flex flex-none flex-col items-center gap-1.5">
            {/* 头像 +（编辑态）随机换一枚（M7-2 收口 components/avatarRing）。 */}
            <Avatar
              name={detail.name}
              seed={avatarPair?.seed}
              salt={avatarPair?.salt}
              size={52}
            />
            {detailEditing && <RandomAvatarButton onRoll={rollDetailAvatar} />}
          </div>
          {/* 页头（用户反馈）：名字即身份——所属团队 chips 已撤，副注仅
          领队/系统保留两种情形；简介（用户迭代 2026-09-06）是内容行——
          只读态有值才显示，编辑态换成简介输入框。 */}
          <div className="min-w-0 flex-1">
            {detailEditing && !nameLocked ? (
              <Input
                value={detailDraftName}
                onChange={(e) => setDetailDraftName(e.target.value)}
                aria-label="角色名称"
                className="h-9 w-full text-lg font-semibold"
              />
            ) : (
              <div className="text-lg font-semibold tracking-tight text-foreground">
                {detail.name}
              </div>
            )}
            {detailEditing ? (
              <Input
                value={detailDraftProfile}
                onChange={(e) => setDetailDraftProfile(e.target.value)}
                aria-label="角色简介"
                placeholder="一句话简介，展示在角色列表卡片上"
                className="mt-1.5 h-8 w-full text-sm"
              />
            ) : (
              <>
                {/* root 不走硬编码副注（用户反馈：与建库播种进 roles.profile
                的简介同义重复）——system 的页头说明只显示库内简介，「不能加入
                团队」仍由下方手册卡的 root 提示行交代。 */}
                {(isLeader || (nameLocked && detail.isRoot !== true)) && (
                  <div className={cn(MUTED_CLASS, 'mt-0.5')}>
                    {ROSTER_DETAIL_SUBTITLE_META[isLeader ? 'leader' : 'protected']}
                  </div>
                )}
                {detail.profile !== undefined && detail.profile.trim() !== '' && (
                  <div className={cn(MUTED_CLASS, 'mt-0.5 max-w-[520px]')}>
                    {detail.profile.trim()}
                  </div>
                )}
              </>
            )}
          </div>
          {/* 编辑/保存/取消（用户迭代 2026-09-03）：编辑钮从手册卡上移到
          详情页头——与名称/头像同一行收口。 */}
          {detailEditing ? (
            // 页头保存行（M7-1 收口 FormFooterActions，ghost 取消档）。
            <FormFooterActions
              className="flex-none gap-2"
              cancelVariant="ghost"
              cancelDisabled={detailSaving}
              confirmDisabled={detailSaving}
              confirmLabel="保存"
              onCancel={cancelDetailEdit}
              onConfirm={saveDetail}
            />
          ) : (
            <Button type="button" size="sm" variant="outline" onClick={startDetailEdit}>
              <PenLine className="h-3.5 w-3.5" />
              编辑
            </Button>
          )}
        </div>
        {detailError !== null && (
          <div className="mt-2">
            <FormErrorNote>{detailError}</FormErrorNote>
          </div>
        )}
      </Card>
      <Card className={PANEL_CARD_CLASS}>
        <div className={cn(SECTION_TITLE_CLASS, 'flex items-center gap-2')}>
          <span>角色手册（Markdown）</span>
        </div>
        {/* root 提示行：编辑态常显（用户反馈：手册有内容后编辑时看不到注入
        说明），只读态仍只在空手册的引导场景出现；以已保存的 persona_md 为准。 */}
        {detail.isRoot === true && (detailEditing || (detail.personaMd ?? '').trim() === '') && (
          <div className={cn(MUTED_CLASS, 'mb-2 text-sm')}>
            这是注入主对话的特殊角色：保存的手册(MD)会注入主对话窗口的 system 提示词；该角色不能加入团队。
          </div>
        )}
        {detailEditing ? (
          <MdEditor value={detailDraftMd} onChange={setDetailDraftMd} minHeight={220} />
        ) : (
          <MarkdownDoc text={detailHandbookText(detail)} />
        )}
      </Card>
    </div>
  );
}
