/**
 * 角色 tab（docs/13.3 角色）：角色库列表 / 构建工作台 / 角色详情（手册
 * 编辑，docs/19.6.2 构建师播报联动）+ 添加成员预填入口。
 * 符号自 eteamsView.tsx 原样搬出（docs/32 32.5.1 纯移动、零行为变更），
 * 依赖 buildDraft（R1 类型边 DraftEdit 走 import type）与 memberDialog、shared。
 *
 * @module dsh-eteams/client/pages/teamsView/membersTab
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import ArrowLeft from 'lucide-react/dist/esm/icons/arrow-left.mjs';
import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right.mjs';
import Dices from 'lucide-react/dist/esm/icons/dices.mjs';
import PenLine from 'lucide-react/dist/esm/icons/pen-line.mjs';
import {
  IconPlusOutline16,
  IconSparkle16,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { ADD_PEOPLE_TEMPLATE, type PrefillOutcome } from '../../lib/addPeople';
import type { RosterMember } from '../../lib/api';
import type { TeamSnapshot } from '../../lib/monitor';
import { cn } from '../../lib/cn';
import { Avatar } from '../../features/avatar/avatar';
import { MdEditor } from '../../features/mdEditor/mdEditor';
import { Alert } from '../../components/ui/alert';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { useDispatch, useSelector } from 'react-redux';
import type { RootState } from '../../store/app';
import {
  BUILD_STEPS,
  CommandChip,
  DraftPreview,
  EMPTY_EDIT,
  PREFILL_STEPS,
  fromBuildDraft,
  handbookSeed,
  type DraftEdit,
} from './buildDraft';
import { MemberDialog } from './memberDialog';
import { MarkdownDoc } from './markdownDoc';
import {
  CARD_GRID_CLASS,
  CHIP_CLASS,
  EMPTY_CLASS,
  FormErrorNote,
  FORM_LABEL_CLASS,
  FORM_ROW_CLASS,
  GLYPH_TONE_CLASS,
  LEADER_NAME,
  LINE_CLASS,
  LIST_COUNT_CLASS,
  LIST_TITLE_CLASS,
  MUTED_CLASS,
  PANEL_CARD_CLASS,
  Pill,
  PROTECTED_MEMBERS,
  SECTION_TITLE_CLASS,
  TEXT2_CLASS,
  memberRank,
} from './shared';

/** 原 styles.roleCard（同上：底色/边框/悬停由 .eteams-role-row 样式表接管）；
 * p-4 = D22f 卡内呼吸感。用户迭代 2026-09-03：改一行式横排——头像在前、
 * 名称（与所属团队）随后、删除钮常驻行尾（不再 hover 显形）。 */
const ROLE_CARD_CLASS =
  'flex min-w-0 cursor-pointer items-center gap-2.5 rounded-xl p-4 text-left text-foreground';
/** 新增角色方式选择卡（choose 态，用户迭代 2026-09-03）：整行可点（图标 +
 * 标题 + 描述 + 右箭头）；底色/边框/悬停同角色卡片走 .eteams-role-row。 */
const ADD_MODE_CARD_CLASS =
  'flex w-full cursor-pointer items-center gap-3 rounded-xl p-4 text-left text-foreground';
/** 方式选择卡图标底（品牌淡底圆牌，STEP_NUM_CLASS 同口径放大到 32px）。 */
const ADD_MODE_ICON_CLASS =
  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-business-tint text-primary';

/**
 * 随机头像对（用户迭代 2026-09-04：AI 草稿确认页 / 手动创建页补上「随机头像」
 * 钮，与详情页同口径共用）——seed 0..996（hashName % 997）、salt 0..999。
 */
function rollAvatarPair(): { seed: number; salt: number } {
  return {
    seed: Math.floor(Math.random() * 997),
    salt: Math.floor(Math.random() * 1000),
  };
}
/** 原 styles.pagePill（分页计数 pill：D22e 中性 pill 口径 12px/20）。 */
const PAGE_PILL_CLASS =
  'inline-flex w-fit items-center whitespace-nowrap rounded-full bg-[color:var(--eteams-pill-bg)] px-2.5 py-0.5 text-xs text-[color:var(--eteams-pill-ink)]';
/** 原 styles.buildStep / stepRow / stepNum（构建工作台）；原 prefillBanner
 * docs/23 S23-3 迁移 shadcn Alert（default 变体 + 品牌淡底覆盖），常量删除。
 * D22d：步骤行 14px/24、序号圆牌 12px。 */
const BUILD_STEP_CLASS = 'flex items-center gap-2 py-0.5 text-sm leading-6';
const STEP_ROW_CLASS = `mt-2 flex items-start gap-2 text-sm leading-6 ${TEXT2_CLASS}`;
const STEP_NUM_CLASS =
  'mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-business-tint text-xs font-semibold text-[color:var(--eteams-brand-ink)]';

/**
 * The role detail handbook (用户反馈：去掉人设摘要，全部提炼到角色手册).
 * 用户迭代 2026-09-03：编辑钮挪到详情页头，名称/头像/手册一处编辑——保存
 * 走 POST /roster 整条 upsert（host 替换整个条目，现有字段全量重发）；
 * 领队经宿主 allowLeader 放行同样可编辑（名称仍为系统保留）。改名 =
 * 保存新名 + 删除旧条目（保留角色名称锁死，不改名）。
 */

export function MembersTab({
  members,
  pool,
  team,
  onDeleted,
  onPrefillAddPeople,
  openAddTick,
  onAddTickConsumed,
}: {
  members: RosterMember[];
  pool: TeamSnapshot[];
  team: TeamSnapshot | undefined;
  onDeleted: () => void;
  onPrefillAddPeople: () => 'set' | 'copied' | 'aborted';
  /** 创建卡片跳转信号：>0 时打开新增工作台（docs/19.9.5）。 */
  openAddTick: number;
  /** 消费回执：信号打开新增工作台后清零（防滞留信号重进角色页时复跳）。 */
  onAddTickConsumed: () => void;
}): ReactNode {
  const dispatch = useDispatch();
  const [view, setView] = useState<'list' | 'add' | 'detail'>('list');
  const [detailName, setDetailName] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [personaMd, setPersonaMd] = useState('');
  // 新增方式（用户迭代 2026-09-03）：进入新增页先选「手动创建 / AI 创建」，
  // 不再默认把命令填进对话输入框——点「AI 创建」此刻才预填，手动创建直接
  // 进角色手册编辑页。
  const [addMode, setAddMode] = useState<'choose' | 'ai' | 'manual'>('choose');
  // AI 创建的预填结果（'set' 填入输入框 / 'copied' 退化剪贴板 / 'aborted'
  // 用户取消覆盖），驱动 AI 创建页的状态行。
  const [aiPrefill, setAiPrefill] = useState<PrefillOutcome | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  // 角色列表搜索 + 分页（用户反馈）：按名字/角色字段过滤，每页 8 条。
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const MEMBER_PAGE_SIZE = 8;
  const filtered = members.filter((m) => {
    const q = query.trim().toLowerCase();
    if (q === '') return true;
    return m.name.toLowerCase().includes(q) || m.role.toLowerCase().includes(q);
  });
  const sortedMembers = [...filtered].sort((a, b) => memberRank(a.name) - memberRank(b.name));
  const totalPages = Math.max(1, Math.ceil(sortedMembers.length / MEMBER_PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = sortedMembers.slice(
    safePage * MEMBER_PAGE_SIZE,
    (safePage + 1) * MEMBER_PAGE_SIZE,
  );

  // 构建会话（docs/19.6.2, D18-5）：S10 迁入 build model——session 经
  // useSelector 读取，轮询照旧由 refreshBuild 发 `build/fetchBuild`；
  // 以 startedAt 为会话键去重自动跳转（用户手动离开后不反复强拉，状态
  // 再迁移才再次跳转）的侧效应搬进下方 useEffect。
  const build = useSelector((s: RootState) => s.build.session);
  const [draftEdit, setDraftEdit] = useState<DraftEdit>(EMPTY_EDIT);
  const [confirming, setConfirming] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // AI 草稿确认页「随机头像」（用户迭代 2026-09-04）：换过的头像对仅本地
  // 预览——确认入库时随 payload 透传，未换过则沿用构建师定的原对。
  const [draftAvatarRoll, setDraftAvatarRoll] = useState<{ seed: number; salt: number } | null>(
    null,
  );
  const seenSessionRef = useRef(0);
  const seenReviewRef = useRef(0);
  const draftInitRef = useRef(0);

  const refreshBuild = useCallback((): void => {
    // S10：直接 await api 的调用点改 dispatch；失败由 effect 落 state.error
    // ——迁移前这里 .catch(() => undefined) 同为静默面。
    void dispatch({ type: 'build/fetchBuild' });
  }, [dispatch]);
  // 会话侧效应（原 refreshBuild .then 内联逻辑，数据源改 store）：以
  // startedAt 为会话键去重自动跳转（用户手动离开后不反复强拉，状态再
  // 迁移才再次跳转）；待确认草稿到达/刷新时重置编辑表单（对话里继续
  // 调整 → 表单跟着刷新）。
  useEffect(() => {
    if (build === null) return;
    if (build.startedAt !== seenSessionRef.current) {
      seenSessionRef.current = build.startedAt;
      // 新会话不再强制跳创建页（docs/19.16）：发送时刻由对话卡片负责
      // openMemberBuilder——这里强跳会把用户每次回面板都拽进 add 视图，
      // 导致「构建时进不去对话/看板」。
    }
    if (build.status === 'awaiting_confirmation' && seenReviewRef.current !== build.startedAt) {
      seenReviewRef.current = build.startedAt;
      // AI 创建流（用户迭代 2026-09-03）：草稿确认态属于 AI 创建路径，自动
      // 跳转时顺带把新增页切到 ai 模式，避免回落到方式选择页。
      setAddMode('ai');
      setView('add');
    }
    if (
      build.status === 'awaiting_confirmation' &&
      build.draft !== null &&
      build.updatedAt !== draftInitRef.current
    ) {
      draftInitRef.current = build.updatedAt;
      setDraftEdit(fromBuildDraft(build.draft));
      // 新草稿到达（或对话里调整后刷新）：换过的头像覆盖作废，回到构建师定的对。
      setDraftAvatarRoll(null);
    }
  }, [build]);
  useEffect(() => {
    refreshBuild();
    const h = setInterval(refreshBuild, 1500);
    return () => clearInterval(h);
  }, [refreshBuild]);

  // 创建卡片跳转（docs/19.9.5）：父级消费制——滞留信号曾让重进角色页时
  // 自动跳进新增工作台；tick 归零后复位 lastTickRef。
  const lastAddTickRef = useRef(0);
  useEffect(() => {
    if (openAddTick === 0) {
      lastAddTickRef.current = 0;
      return;
    }
    if (openAddTick !== lastAddTickRef.current) {
      lastAddTickRef.current = openAddTick;
      setAddMode('ai');
      setView('add');
      onAddTickConsumed();
    }
  }, [openAddTick, onAddTickConsumed]);

  // 删除角色（用户反馈）：先弹确认框；失败信息显式上报。领队与角色构建师
  // 为保留角色，面板不给删除按钮（宿主同样拒删）。
  const del = (memberName: string): void => {
    if (!window.confirm(`确定删除角色「${memberName}」？删除后不可恢复。`)) return;
    setListError(null);
    // S10：删除改发 `roster/deleteRoster`；失败 reject → 显式上报（行为不变）。
    void (async (): Promise<void> => {
      try {
        await dispatch({ type: 'roster/deleteRoster', payload: memberName });
        onDeleted();
      } catch (e) {
        setListError(e instanceof Error ? e.message : String(e));
      }
    })();
  };

  // —— 角色详情编辑（用户迭代 2026-09-03）——
  // 编辑钮挪到详情页头：名称输入 + 随机头像 + 保存/取消一行收口，手册编辑
  // 器跟在页头卡下。领队/角色构建师同样可编辑（宿主对面板显式保存放行，
  // 见 roster.ts allowLeader）；仅名称锁死——领队名绑定团队领队卡、改用
  // 「新增角色」另建。改名 = 保存新名 + 删除旧条目（两步，非事务）。
  const [detailEditing, setDetailEditing] = useState(false);
  const [detailDraftName, setDetailDraftName] = useState('');
  const [detailDraftAvatar, setDetailDraftAvatar] = useState<{ seed: number; salt: number } | null>(
    null,
  );
  const [detailDraftMd, setDetailDraftMd] = useState('');
  const [detailSaving, setDetailSaving] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const startDetailEdit = (): void => {
    if (detail === null) return;
    setDetailDraftName(detail.name);
    setDetailDraftAvatar(detail.avatar ?? null);
    setDetailDraftMd(handbookSeed(detail));
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
            ...(detail.duty !== undefined ? { duty: detail.duty } : {}),
            ...(detail.style !== undefined ? { style: detail.style } : {}),
            ...(detail.skills !== undefined ? { skills: detail.skills } : {}),
            ...(Array.isArray(detail.rules) ? { rules: detail.rules } : {}),
            ...(detail.executionPrompt !== undefined
              ? { executionPrompt: detail.executionPrompt }
              : {}),
            ...(detail.model !== undefined ? { model: detail.model } : {}),
            ...(detail.reasoningEffort !== undefined
              ? { reasoningEffort: detail.reasoningEffort }
              : {}),
            ...(detailDraftAvatar !== null ? { avatar: detailDraftAvatar } : {}),
            personaMd: detailDraftMd,
          },
        });
        if (nameChanged && !nameLocked) {
          // 改名 = 新条目已落库后移除旧条目；保留角色锁名不会走到这里。
          await dispatch({ type: 'roster/deleteRoster', payload: detail.name });
        }
        setDetailName(newName); // 详情跟随新名（改名后停在详情页）
        setDetailEditing(false);
        onDeleted();
      } catch (e) {
        setDetailError(e instanceof Error ? e.message : String(e));
      } finally {
        setDetailSaving(false);
      }
    })();
  };

  // 确认入库（D18-6 主路径）：修改后的草稿经 POST /rolebuilder/confirm 由
  // 宿主落库 roster 并翻转会话状态；确认前零落库。
  const confirmDraft = async (): Promise<void> => {
    setConfirming(true);
    setFormError(null);
    try {
      // S10：确认入库改发 `build/confirmBuild`（effect 透传 api，失败 reject
      // → 表单错误提示，行为不变）。
      await dispatch({
        type: 'build/confirmBuild',
        payload: {
          name: draftEdit.name.trim(),
          role: draftEdit.role.trim(),
          duty: draftEdit.duty,
          style: draftEdit.style,
          skills: draftEdit.skills,
          rules: draftEdit.rulesText
            .split('\n')
            .map((r) => r.trim())
            .filter((r) => r !== ''),
          executionPrompt: draftEdit.executionPrompt,
          personaMd: draftEdit.personaMd,
          // 随机头像（用户迭代 2026-09-04）：换过发换后的，否则透传构建师
          // 定的原对（宿主 /rolebuilder/confirm 校验 seed/salt 后落库）。
          ...(draftAvatarRoll !== null
            ? { avatar: draftAvatarRoll }
            : build?.draft?.avatar !== undefined
              ? { avatar: build.draft.avatar }
              : {}),
        },
      });
      // 已入库卡下线（用户迭代 2026-09-04）：确认成功即回「AI 创建 / 手动
      // 创建」方式选择页——再建一个从方式卡走；预填状态一并清掉，上一轮
      // 的「已填充到对话输入框」横幅不再残留。
      setAddMode('choose');
      setAiPrefill(null);
      onDeleted();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setConfirming(false);
      refreshBuild();
    }
  };

  const abandon = async (): Promise<void> => {
    setConfirming(true);
    // S10：放弃改发 `build/cancelBuild`（effect 失败上抛；组件侧迁移前就
    // 吞错——.catch(() => undefined)——行为不变）。
    try {
      await dispatch({ type: 'build/cancelBuild' });
    } catch {
      // 与迁移前一致：放弃失败不打断面板，轮询会带回会话真实状态。
    }
    setConfirming(false);
    refreshBuild();
  };

  // 继续构建（docs/19.16）：会话文件保存完整上下文（步骤/草稿/需求），
  // 宿主恢复会话并唤醒后台构建代理，从中断处接着跑。
  // 失败要可见（用户反馈 2026-09-05「点继续构建没反应」）：宿主对父会话
  // 不在线等情形会诚实拒绝（409/400），此前组件侧吞错导致点了毫无反馈——
  // 与访谈提交同口径，把拒绝原因亮在卡里。
  const [resumeError, setResumeError] = useState<string | null>(null);
  const resume = async (): Promise<void> => {
    setConfirming(true);
    setResumeError(null);
    // S10：继续构建改发 `build/resumeBuild`（effect 失败上抛）。
    try {
      await dispatch({ type: 'build/resumeBuild' });
    } catch (e) {
      setResumeError(e instanceof Error ? e.message : String(e));
    }
    setConfirming(false);
    refreshBuild();
  };

  // 意图访谈作答只走主会话（用户反馈 2026-09-05「访谈怎么放到创建页面去了」）：
  // 问题经 steer 弹给主代理（ask_user_question 选择框落在对话里，提交走
  // eteams_interview_answer），工作台不再渲染平行问卷——此前的
  // interviewPick/togglePick/submitInterviewAnswers 随之撤除。
  // 重启代理等操作失败要可见（父会话不在线 / 网络问题），不再静默吞掉。
  const [interviewError, setInterviewError] = useState<string | null>(null);
  // 手动重启构建代理（用户迭代）：不答题也能派新代理重新核查/重新出题。
  const restartBuildAgent = async (): Promise<void> => {
    setConfirming(true);
    setInterviewError(null);
    // S10：重启改发 `build/restartBuild`；失败 reject → 显式提示（行为不变）。
    try {
      await dispatch({ type: 'build/restartBuild' });
    } catch (e) {
      setInterviewError(e instanceof Error ? e.message : String(e));
    }
    setConfirming(false);
    refreshBuild();
  };

  // AI 创建入口（方式选择卡共用）：进页不直接填充对话框（用户迭代
  // 2026-09-05）——页面上给「填充 / 复制」两个按钮，点「填充」（prefillAi
  // → onPrefillAddPeople → addPeople.prefillComposer）此刻才把命令预填进
  // 对话输入框；结果落 aiPrefill 驱动状态行。每次进页重置预填态，两个
  // 按钮重新出现（已填充过的横幅不跨进入残留）。
  const fillAi = (): void => {
    setAiPrefill(null);
    setAddMode('ai');
  };
  const prefillAi = (): void => {
    setAiPrefill(onPrefillAddPeople());
  };
  // 复制反馈（用户反馈 2026-09-05 第二批）：writeClipboard 回传是否真的写进
  // 剪贴板——成功亮「✓ 已复制」、失败亮「复制失败」各 2 秒（此前点了零反
  // 馈）。计时器挂 ref：重复点击先清旧的，卸载后不误触 setState。
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const copyTimer = useRef<number | null>(null);
  const copyTemplate = async (): Promise<void> => {
    const ok = await writeClipboard(ADD_PEOPLE_TEMPLATE).catch(() => false);
    setCopyState(ok ? 'ok' : 'fail');
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopyState('idle'), 2000);
  };

  // 手动创建（用户迭代 2026-09-03）：面板直连名册保存（`roster/saveRoster`
  // → POST /roster，与详情页 HandbookEditor 同一写路径），不再借对话命令
  // 中转。角色不再单独收集（用户反馈：名字即身份）——host 要求非空 role，
  // 随名回填；personaMd 留空则手册随后可在详情页补写。
  const [manualSaving, setManualSaving] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  // 手动创建「随机头像」（用户迭代 2026-09-04）：进页即随机一枚预览，按钮
  // 随时再换；保存时随 payload 落库（roster.ts upsert）。
  const [manualAvatar, setManualAvatar] = useState<{ seed: number; salt: number } | null>(null);
  const saveManual = async (): Promise<void> => {
    const trimmed = name.trim();
    // 同名即覆盖（宿主 upsert 语义）——手动直存前先挡一手，避免误盖已有角色。
    if (members.some((m) => m.name === trimmed)) {
      setManualError(`已存在同名角色「${trimmed}」——换一个名字，或到角色详情里编辑它。`);
      return;
    }
    setManualSaving(true);
    setManualError(null);
    try {
      await dispatch({
        type: 'roster/saveRoster',
        payload: {
          name: trimmed,
          // 名字即身份：role 随名回填（host 契约要求非空，见 roster.ts upsert）。
          role: trimmed,
          ...(personaMd.trim() !== '' ? { personaMd } : {}),
          ...(manualAvatar !== null ? { avatar: manualAvatar } : {}),
        },
      });
      setName('');
      setPersonaMd('');
      setManualAvatar(null);
      setAddMode('choose');
      onDeleted(); // 保存成功 → 父级重拉名册，翻回列表即见新角色
      setView('list');
    } catch (e) {
      setManualError(e instanceof Error ? e.message : String(e));
    } finally {
      setManualSaving(false);
    }
  };

  // 该角色已加入的团队（按当前可见团队池计算）。
  const teamsOf = (memberName: string): string[] =>
    pool.filter((t) => t.members.some((mm) => mm.name === memberName)).map((t) => t.name);

  const detail = members.find((m) => m.name === detailName) ?? null;
  const detailMemberView =
    detail === null ? null : (team?.members.find((m) => m.name === detail.name) ?? null);

  if (view === 'add') {
    // AI 草稿确认页生效头像（用户迭代 2026-09-04）：换过取换后的，否则取
    // 构建师定的原对——页头小像与表单头像行同源，不会各显各的。
    const draftAvatarPair =
      draftAvatarRoll ?? (build !== null && build.draft !== null ? build.draft.avatar : undefined);
    // 访谈未答 = 阶段代理按设计已结束回合，此刻在等用户——显示「等你作答」
    // 而不是转圈的「工作中」，否则看起来像卡死（显示状态要诚实）。
    const interviewWaiting =
      build !== null &&
      build.status === 'active' &&
      build.interview !== undefined &&
      build.interview.answers === undefined;
    return (
      <div className="min-w-0 overflow-x-hidden">
        <style>{'@keyframes eteams-spin{to{transform:rotate(360deg)}}'}</style>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="secondary" onClick={() => setView('list')}>
            <ArrowLeft className="h-3.5 w-3.5" />
            返回角色列表
          </Button>
        </div>
        <Card className={cn(PANEL_CARD_CLASS, 'mt-2')}>
          {build !== null && build.status === 'active' && (
            <div>
              <div className="flex items-center gap-2">
                {interviewWaiting ? (
                  <PenLine className="h-4 w-4 shrink-0 text-primary" />
                ) : build.draft?.avatar !== undefined ? (
                  <Avatar
                    name={build.draft.name}
                    seed={build.draft.avatar.seed}
                    salt={build.draft.avatar.salt}
                    size={30}
                  />
                ) : (
                  <span className="inline-flex text-primary [animation:eteams-spin_1s_linear_infinite]">
                    <IconSparkle16 />
                  </span>
                )}
                <div className={cn(LINE_CLASS, 'my-0 font-semibold')}>
                  {interviewWaiting ? (
                    <>
                      意图访谈待作答
                      {build.draft?.name !== undefined && build.draft.name !== ''
                        ? ` · ${build.draft.name}`
                        : ''}
                      ——到主会话作答后自动续跑
                    </>
                  ) : build.draft?.name !== undefined && build.draft.name !== '' ? (
                    `角色构建师工作中 · ${build.draft.name}…`
                  ) : (
                    '角色构建师工作中…'
                  )}
                </div>
                {interviewWaiting ? (
                  <Pill tone="warn">等你作答</Pill>
                ) : (
                  <Pill tone="info">构建中</Pill>
                )}
                <span className="flex-1" />
                {interviewWaiting && (
                  <Button
                    size="sm"
                    disabled={confirming}
                    onClick={() => void restartBuildAgent()}
                    title="不答题，直接派一个新代理重新核查进度并按需重新出题"
                  >
                    重启代理
                  </Button>
                )}
                {/* 构建中也能放弃（docs/19.16）：作废会话并中断后台构建代理。 */}
                <Button size="sm" disabled={confirming} onClick={() => void abandon()}>
                  放弃
                </Button>
              </div>
              {build.interview !== undefined && build.interview.answers === undefined && (
                // 意图访谈去工作台化（用户反馈 2026-09-05「访谈怎么放到创建
                // 页面去了」）：作答只走主会话——宿主已把问题经 steer 弹给主
                // 代理（ask_user_question 选择框落在对话里，提交走
                // eteams_interview_answer），工作台只提示去处，不再渲染平行
                // 问卷（两套入口让用户在哪答都不确定）。
                <div className="mb-1 mt-2.5 rounded-[10px] border border-solid border-primary px-3 py-2.5">
                  <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                    <PenLine className="h-4 w-4 text-primary" />
                    意图访谈——到主会话作答
                  </div>
                  <div className={MUTED_CLASS}>
                    问题已发到发起 /eteam 的对话——回到主会话，在弹出的选择框里逐题作答，答完构建自动继续。没看到选择框？点「重启代理」重新出题。
                  </div>
                  {interviewError !== null && (
                    <div className="mt-2 text-xs leading-5 text-destructive">
                      ⚠️ {interviewError}
                    </div>
                  )}
                </div>
              )}
              <div className="mb-1 mt-2.5">
                {BUILD_STEPS.map((s) => {
                  const done = build.stepsDone.includes(s);
                  const current = !done && build.step === s;
                  const glyphState = done ? 'done' : current ? 'current' : 'pending';
                  return (
                    <div key={s} className={BUILD_STEP_CLASS}>
                      <span className={cn(GLYPH_TONE_CLASS[glyphState], 'font-semibold')}>
                        {done ? '✔' : current ? '●' : '◌'}
                      </span>
                      <span
                        className={done || current ? 'text-foreground' : 'text-muted-foreground'}
                      >
                        {s}
                      </span>
                      {current && <span className={MUTED_CLASS}>进行中…</span>}
                    </div>
                  );
                })}
              </div>
              {build.note !== '' && <div className={MUTED_CLASS}>{build.note}</div>}
              {build.request !== '' && (
                <div className={cn(MUTED_CLASS, 'mt-1')}>需求：{build.request}</div>
              )}
              {build.draft !== null && <DraftPreview draft={build.draft} />}
            </div>
          )}
          {build !== null && build.status === 'awaiting_confirmation' && build.draft !== null && (
            <div>
              <div className={cn('flex items-center gap-2', LINE_CLASS, 'font-semibold')}>
                {draftAvatarPair !== undefined && (
                  <Avatar
                    name={draftEdit.name.trim() !== '' ? draftEdit.name.trim() : build.draft.name}
                    seed={draftAvatarPair.seed}
                    salt={draftAvatarPair.salt}
                    size={30}
                  />
                )}
                草稿已就绪——可直接修改，确认后入库
              </div>
              {formError !== null && <FormErrorNote>{formError}</FormErrorNote>}
              {/* 头像行（用户迭代 2026-09-04）：预览 + 随机换一枚，与下方
              角色名/角色/手册同一表单节奏（label 在上、控件在下）。 */}
              <div className={cn(FORM_ROW_CLASS, 'mt-2')}>
                <span className={FORM_LABEL_CLASS}>头像</span>
                <div className="flex items-center gap-2.5">
                  <div className="rounded-full border-2 border-solid p-0.5 leading-none border-business-tint">
                    <Avatar
                      name={draftEdit.name.trim() !== '' ? draftEdit.name.trim() : build.draft.name}
                      seed={draftAvatarPair?.seed}
                      salt={draftAvatarPair?.salt}
                      size={40}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 gap-1 px-1.5 text-xs text-muted-foreground"
                    onClick={() => setDraftAvatarRoll(rollAvatarPair())}
                    title="随机换一个头像"
                  >
                    <Dices className="h-3.5 w-3.5" />
                    随机头像
                  </Button>
                </div>
              </div>
              <div className={FORM_ROW_CLASS}>
                <span className={FORM_LABEL_CLASS}>角色名</span>
                <Input
                  value={draftEdit.name}
                  onChange={(e) => setDraftEdit({ ...draftEdit, name: e.target.value })}
                />
              </div>
              <div className={FORM_ROW_CLASS}>
                <span className={FORM_LABEL_CLASS}>角色</span>
                <Input
                  value={draftEdit.role}
                  onChange={(e) => setDraftEdit({ ...draftEdit, role: e.target.value })}
                />
              </div>
              <div className={FORM_ROW_CLASS}>
                <span className={FORM_LABEL_CLASS}>
                  人设手册（统一 Markdown：frontmatter + 身份/使命/规则/领域专章/沟通风格）
                </span>
                <MdEditor
                  value={draftEdit.personaMd}
                  onChange={(next) => setDraftEdit({ ...draftEdit, personaMd: next })}
                />
              </div>
              <div className="mt-2 flex items-center gap-2">
                <Button
                  size="sm"
                  disabled={
                    confirming || draftEdit.name.trim() === '' || draftEdit.role.trim() === ''
                  }
                  onClick={() => void confirmDraft()}
                >
                  <IconPlusOutline16 />
                  确认入库
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={confirming}
                  onClick={() => void abandon()}
                >
                  放弃
                </Button>
                <span className={MUTED_CLASS}>也可以在对话里继续调整，这里会跟着刷新。</span>
              </div>
            </div>
          )}
          {build !== null &&
            build.status === 'cancelled' &&
            addMode === 'ai' &&
            build.parentOnline !== false && (
              // 已放弃的构建（用户迭代 2026-09-05：只在 AI 创建页出现，并标出
              // 在建角色——草稿名优先，没起名就退回原始需求）：上下文（步骤/
              // 草稿/需求）都保存在会话里，「继续构建」唤醒后台代理从中断处
              // 接着跑（docs/19.16）。
              // 父会话不在线 → 整卡不渲染（用户反馈 2026-09-05 第二批）：
              // 发起构建的 /eteam 对话没开着时宿主必拒恢复（409），按钮是
              // 死的——进页检测到就不渲染，而不是点了才报错。
              <Card className={PANEL_CARD_CLASS}>
                <div className="flex items-center gap-2">
                  <div className={cn(LINE_CLASS, 'my-0 font-semibold')}>
                    已放弃本次构建
                    {build.draft?.name !== undefined && build.draft.name !== ''
                      ? ` · ${build.draft.name}`
                      : ''}
                  </div>
                  <Pill tone="muted">已中断</Pill>
                </div>
                {build.request !== '' && (
                  <div className={MUTED_CLASS}>需求：{build.request}</div>
                )}
                {build.note !== '' && <div className={MUTED_CLASS}>{build.note}</div>}
                <div className="mt-2 flex items-center gap-2">
                  <Button size="sm" disabled={confirming} onClick={() => void resume()}>
                    继续构建
                  </Button>
                  <span className={MUTED_CLASS}>上下文已保存——从中断处接着跑，不用从头再来。</span>
                </div>
                {resumeError !== null && (
                  // 恢复被拒要可见（父会话不在线 / 会话状态翻页竞态等）：拒绝原因
                  // 亮在卡里，与访谈提交失败同口径（destructive token 错误面）。
                  <div className="mt-2 text-xs leading-5 text-destructive">⚠️ {resumeError}</div>
                )}
              </Card>
            )}
          {/* 已入库（用户迭代 2026-09-04）不再渲染回顾卡：确认成功在对话卡
          与角色列表各有反馈，新增页回到「AI 创建 / 手动创建」方式选择——
          再建一个从方式选择卡走，不再停留上一轮的已入库回顾。 */}
          {(build === null || build.status === 'cancelled' || build.status === 'confirmed') &&
            (addMode === 'manual' ? (
              // 手动创建（用户迭代 2026-09-03）：直接进入角色手册编辑页，
              // 保存即入库（`roster/saveRoster` 直连），不经对话命令中转。
              <div>
                <div className="flex items-center gap-2">
                  <span className="inline-flex text-primary">
                    <PenLine className="h-4 w-4" />
                  </span>
                  <div className={cn(LINE_CLASS, 'font-semibold')}>手动创建</div>
                  <Pill tone="muted">直接填写手册</Pill>
                  <span className="min-w-0 flex-1" />
                  <Button size="sm" variant="ghost" onClick={() => setAddMode('choose')}>
                    返回
                  </Button>
                </div>
                {/* 头像行（用户迭代 2026-09-04）：进页即随机一枚预览，
                「随机头像」随时再换——保存时随 payload 落库。 */}
                <div className={cn(FORM_ROW_CLASS, 'mt-2.5')}>
                  <span className={FORM_LABEL_CLASS}>头像</span>
                  <div className="flex items-center gap-2.5">
                    <div className="rounded-full border-2 border-solid p-0.5 leading-none border-business-tint">
                      <Avatar
                        name={name}
                        seed={manualAvatar?.seed}
                        salt={manualAvatar?.salt}
                        size={40}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 gap-1 px-1.5 text-xs text-muted-foreground"
                      onClick={() => setManualAvatar(rollAvatarPair())}
                      title="随机换一个头像"
                    >
                      <Dices className="h-3.5 w-3.5" />
                      随机头像
                    </Button>
                  </div>
                </div>
                <div className={FORM_ROW_CLASS}>
                  <span className={FORM_LABEL_CLASS}>角色名</span>
                  <Input
                    value={name}
                    placeholder="角色名，如：alice"
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <div className={FORM_ROW_CLASS}>
                  <span className={FORM_LABEL_CLASS}>
                    角色手册（Markdown：frontmatter + 身份/使命/规则/领域专章/沟通风格/交付标准）
                  </span>
                  <MdEditor value={personaMd} onChange={setPersonaMd} minHeight={300} />
                </div>
                {manualError !== null && <FormErrorNote>保存失败：{manualError}</FormErrorNote>}
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    size="sm"
                    disabled={manualSaving || name.trim() === ''}
                    onClick={() => void saveManual()}
                  >
                    <IconPlusOutline16 />
                    保存入库
                  </Button>
                  <span className={MUTED_CLASS}>
                    保存后角色进入角色列表，到「团队」页拉进团队即可使用。
                  </span>
                </div>
              </div>
            ) : addMode === 'ai' ? (
              // AI 创建（用户迭代 2026-09-05）：进页不直接填充对话框——先给
              // 「填充 / 复制」两个按钮，点「填充」才把命令填进对话输入框，
              // 回车发送后回到本页实时看构建。
              <div>
                <div className="flex items-center gap-2">
                  <span className="inline-flex text-primary">
                    <IconSparkle16 />
                  </span>
                  <div className={cn(LINE_CLASS, 'font-semibold')}>AI 创建 · 角色构建师</div>
                  <Pill tone="info">对话式构建</Pill>
                  <span className="min-w-0 flex-1" />
                  <Button size="sm" variant="ghost" onClick={() => setAddMode('choose')}>
                    返回
                  </Button>
                </div>
                {aiPrefill === 'set' && (
                  <Alert className="mt-2.5 flex items-start gap-2 rounded-[10px] bg-business-tint px-4 py-3">
                    <span className="text-sm font-semibold text-[color:var(--eteams-brand-ink)]">
                      ✓ 已填充到对话输入框
                    </span>
                  </Alert>
                )}
                {aiPrefill === 'copied' && (
                  <Alert className="mt-2.5 flex items-start gap-2 rounded-[10px] bg-business-tint px-4 py-3">
                    <span className="text-sm font-semibold text-[color:var(--eteams-brand-ink)]">
                      ✓ 命令已复制——去对话输入框粘贴发送
                    </span>
                  </Alert>
                )}
                <CommandChip text={ADD_PEOPLE_TEMPLATE} />
                {PREFILL_STEPS.map((s, i) => (
                  <div key={s} className={STEP_ROW_CLASS}>
                    <span className={STEP_NUM_CLASS}>{i + 1}</span>
                    <span>{s}</span>
                  </div>
                ))}
                {/* 填充/复制两钮常驻（用户反馈 2026-09-05 第二批「点填充按
                钮就都消失了」）：填充成功不再收走按钮行——复制仍随时可用；
                复制带「✓ 已复制」瞬时反馈（writeClipboard 回传 false 时亮
                「复制失败」，不假装成功）。 */}
                <div className="mt-2.5 flex items-center gap-2">
                  <Button size="sm" onClick={prefillAi}>
                    {aiPrefill === 'set' ? '重新填充' : '填充'}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => void copyTemplate()}>
                    {copyState === 'ok' ? '✓ 已复制' : copyState === 'fail' ? '复制失败' : '复制'}
                  </Button>
                  {aiPrefill !== 'set' && (
                    <span className={cn(MUTED_CLASS, 'mt-0')}>
                      {aiPrefill === 'aborted'
                        ? '你保留了输入框里未发送的草稿——再点「填充」会再次询问是否覆盖。'
                        : '点「填充」把命令填进对话输入框，或复制后去对话粘贴发送。'}
                    </span>
                  )}
                </div>
                {aiPrefill === 'set' && (
                  <div className={cn(MUTED_CLASS, 'mt-2.5')}>
                    提示：已模拟「键入 /eteam +
                    空格」完成命令认领（claimed）——补全两个【】占位符后直接回车即可；编辑正文时命令高亮收起属正常行为。
                  </div>
                )}
              </div>
            ) : (
              // 方式选择（默认态，用户迭代 2026-09-03）：不再默认预填——两条
              // 创建路径各自显式进入。
              <div>
                <div className="flex items-center gap-2">
                  <span className="inline-flex text-primary">
                    <IconPlusOutline16 />
                  </span>
                  <div className={cn(LINE_CLASS, 'font-semibold')}>新增角色</div>
                  <Pill tone="muted">选择创建方式</Pill>
                </div>
                <div className="mt-3 flex flex-col gap-2.5">
                  <button
                    type="button"
                    className={cn('eteams-role-row', ADD_MODE_CARD_CLASS)}
                    onClick={fillAi}
                  >
                    <span className={ADD_MODE_ICON_CLASS}>
                      <IconSparkle16 />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-foreground">AI 创建</span>
                      <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                        进入后点「填充」把命令填进对话输入框（或复制去粘贴），角色构建师在对话里帮你补全人设；草稿就绪后回来确认入库。
                      </span>
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </button>
                  <button
                    type="button"
                    className={cn('eteams-role-row', ADD_MODE_CARD_CLASS)}
                    onClick={() => {
                      setAiPrefill(null);
                      // 进手动创建即随机一枚（用户迭代 2026-09-04）：预览先行，
                      // 不满意再点「随机头像」换；每次进页都重新随机。
                      setManualAvatar(rollAvatarPair());
                      setAddMode('manual');
                    }}
                  >
                    <span className={ADD_MODE_ICON_CLASS}>
                      <PenLine className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-foreground">手动创建</span>
                      <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                        直接进入角色手册（Markdown）编辑页，填好名字与手册，保存即入库。
                      </span>
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </button>
                </div>
              </div>
            ))}
        </Card>
      </div>
    );
  }

  if (view === 'detail' && detail !== null) {
    const teamNames = teamsOf(detail.name);
    const isLeader = detail.name === LEADER_NAME;
    const nameLocked = PROTECTED_MEMBERS.includes(detail.name);
    // 头像：编辑态取草稿（随机头像实时预览），只读态取条目现值。
    const avatarPair =
      detailEditing && detailDraftAvatar !== null ? detailDraftAvatar : detail.avatar;
    return (
      // 版式：详情列不再限宽（用户要求解除固定宽度），面板全宽利用
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setView('list');
            cancelDetailEdit(); // 编辑中返回列表即丢弃草稿
          }}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          返回角色列表
        </Button>
        <Card className={cn(PANEL_CARD_CLASS, 'mt-2')}>
          <div className="flex items-center gap-3.5">
            {/* 头像描边环（视觉升级）：品牌淡底档（D21b token），柔和不抢戏。
            编辑态头像下挂「随机头像」钮（用户迭代 2026-09-03）。 */}
            <div className="flex flex-none flex-col items-center gap-1.5">
              <div className="rounded-full border-2 border-solid p-0.5 leading-none border-business-tint">
                <Avatar
                  name={detail.name}
                  seed={avatarPair?.seed}
                  salt={avatarPair?.salt}
                  size={52}
                />
              </div>
              {detailEditing && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-1.5 text-xs text-muted-foreground"
                  onClick={rollDetailAvatar}
                  title="随机换一个头像"
                >
                  <Dices className="h-3.5 w-3.5" />
                  随机头像
                </Button>
              )}
            </div>
            {/* 角色（用户反馈）：不再需要标签——名字即身份，手册即人设。 */}
            <div className="min-w-0 flex-1">
              {detailEditing && !nameLocked ? (
                <Input
                  value={detailDraftName}
                  onChange={(e) => setDetailDraftName(e.target.value)}
                  aria-label="角色名称"
                  className="h-9 max-w-[320px] text-lg font-semibold"
                />
              ) : (
                <div className="text-lg font-semibold tracking-tight text-foreground">
                  {detail.name}
                </div>
              )}
              <div className={cn(MUTED_CLASS, 'mt-0.5')}>
                {isLeader
                  ? '领队 · 手册与头像可编辑，名称为系统保留'
                  : nameLocked
                    ? '系统保留角色 · 名称不可改，其余可编辑'
                    : detailEditing
                      ? '编辑中：名称、头像与手册，保存后生效'
                      : '点击右上「编辑」可修改名称、头像与手册'}
              </div>
              {teamNames.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {teamNames.map((n) => (
                    <span key={n} className={CHIP_CLASS}>
                      {n}
                    </span>
                  ))}
                </div>
              )}
            </div>
            {/* 编辑/保存/取消（用户迭代 2026-09-03）：编辑钮从手册卡上移到
            详情页头——与名称/头像同一行收口。 */}
            {detailEditing ? (
              <div className="flex flex-none items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={detailSaving}
                  onClick={cancelDetailEdit}
                >
                  取消
                </Button>
                <Button size="sm" disabled={detailSaving} onClick={saveDetail}>
                  保存
                </Button>
              </div>
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
          {detailEditing ? (
            <MdEditor value={detailDraftMd} onChange={setDetailDraftMd} minHeight={220} />
          ) : (
            <MarkdownDoc text={handbookSeed(detail)} />
          )}
        </Card>
        {team !== undefined && detailMemberView !== null && (
          <MemberDialog team={team} member={detailMemberView} />
        )}
      </div>
    );
  }

  return (
    <div>
      <Card className={PANEL_CARD_CLASS}>
        {/* 页头（用户迭代 2026-09-03）：搜索框与「角色」标题平齐（同一行），
          右侧留新增入口；空列表不渲染搜索框。 */}
        <div className="mb-2.5 flex items-center gap-2">
          <h3 className={cn(LIST_TITLE_CLASS, 'flex-none')}>角色</h3>
          <span className={LIST_COUNT_CLASS}>{members.length} 个</span>
          <span className="min-w-0 flex-1" />
          {members.length > 0 && (
            <Input
              value={query}
              placeholder="搜索角色名…"
              className="w-[200px]"
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0); // 新搜索从头翻页
              }}
            />
          )}
          {build !== null &&
          (build.status === 'active' || build.status === 'awaiting_confirmation') ? (
            // 有未入库的构建草稿：新增入口让位给「待加入角色」，防止误开新
            // 构建把旧草稿顶掉（docs/19.16）。
            <Button
              size="sm"
              onClick={() => {
                setAddMode('ai');
                setView('add');
              }}
            >
              待加入角色
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => {
                // 用户迭代 2026-09-03：新增不再默认预填对话——先进新增页选
                // 「手动创建 / AI 创建」，点「AI 创建」才把命令填进输入框。
                setAddMode('choose');
                setView('add');
              }}
            >
              <IconPlusOutline16 />
              新增角色
            </Button>
          )}
        </div>
        {listError !== null && <FormErrorNote>{listError}</FormErrorNote>}
        {members.length === 0 ? (
          <div className={EMPTY_CLASS}>
            还没有角色。点「新增角色」创建第一个角色——AI
            创建在对话里构建人设，手动创建直接填写角色手册。
          </div>
        ) : (
          <>
            {/* 角色卡片栅格（用户迭代 2026-09-03）：一行式横排——头像在前、
            名称与所属团队随后、删除钮常驻行尾（不再 hover 显形）；
            hover/描边由 ROLE_LIST_CSS 接管。 */}
            <div className={CARD_GRID_CLASS}>
              {pageRows.map((m) => {
                const teamNames = teamsOf(m.name);
                const isProtected = PROTECTED_MEMBERS.includes(m.name);
                return (
                  <div
                    key={m.name}
                    className={cn('eteams-role-row', ROLE_CARD_CLASS)}
                    onClick={() => {
                      setDetailName(m.name);
                      setView('detail');
                    }}
                  >
                    <Avatar name={m.name} seed={m.avatar?.seed} salt={m.avatar?.salt} size={40} />
                    {/* 角色（用户反馈）：不再需要标签——名字即身份。 */}
                    <div className="min-w-0 flex-1">
                      <span className="eteams-role-name block max-w-full text-sm font-semibold text-foreground">
                        {m.name}
                      </span>
                      {teamNames.length > 0 && (
                        <div className={cn('eteams-role-name', MUTED_CLASS, 'mt-0.5')}>
                          {teamNames.join('、')}
                        </div>
                      )}
                    </div>
                    {isProtected ? null : (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="text-destructive hover:border-destructive hover:bg-[color:color-mix(in_srgb,var(--destructive)_6%,transparent)] hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          del(m.name);
                        }}
                      >
                        删除
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
            {totalPages > 1 && (
              <div className="mt-2.5 flex items-center justify-center gap-3">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={safePage === 0}
                  onClick={() => setPage(safePage - 1)}
                >
                  上一页
                </Button>
                <span className={PAGE_PILL_CLASS}>
                  第 {safePage + 1} / {totalPages} 页 · 共 {filtered.length} 个
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={safePage >= totalPages - 1}
                  onClick={() => setPage(safePage + 1)}
                >
                  下一页
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
