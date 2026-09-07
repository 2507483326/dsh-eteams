/**
 * 构建工作台（docs/19.6.2 角色构建师 / D18）：构建会话的订阅轮询、待确认
 * 侧效应、意图访谈去向提示、构建步骤时间线、草稿确认表单与已放弃会话的
 * 续跑卡——自 membersTab 拆出（docs/44 M2，行为零变更），由
 * roster/rosterAddPage 消费；roster 列表页 / 详情页经 {@link
 * useBuildSession} 共用轮询与自动跳转。
 *
 * 轮询纪律（迁移前现状保持，docs/44 44.2.1）：1.5s interval 只在角色域活跃
 * 时跑——roster 三个路由页各自挂一轮（同屏只挂载一页，等效原 membersTab 的
 * 单轮询），离开角色域（路由卸载）即清；session 经 build model 读取，动作
 * 副作用在 model（dispatch `build/…`）。
 *
 * 自动跳转去重升为模块级：原组件内 useRef 的生命周期 = 角色 tab 挂载期，
 * 拆页后「确认页 → 返回列表」会清零 ref、把用户拽回确认页——模块级单例保住
 * 「以 startedAt 为会话键，用户手动离开后不反复强拉，状态再迁移才再次跳转」
 * 的原语义（去重窗口从「tab 挂载期」放宽为「面板运行期」，见 46 清单 M2
 * 验收注记）。
 *
 * @module dsh-eteams/client/pages/roster/buildWorkbench
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useLocation, useNavigate } from 'react-router-dom';
import PenLine from 'lucide-react/dist/esm/icons/pen-line.mjs';
import { IconPlusOutline16, IconSparkle16 } from '@deepseek-ai/dsh-client-ui-primitives';
import type { BuildSession } from '../../lib/api';
import { cn } from '../../lib/cn';
import { errorMessageOf } from '../../lib/errors';
import { Avatar } from '../../features/avatar/avatar';
import { MdEditor } from '../../features/mdEditor/mdEditor';
import { RandomAvatarButton, rollAvatarPair } from '../../components/avatarRing';
import { StepGlyph } from '../../components/stepGlyph';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { usePoll } from '../../hooks/usePoll';
import type { RootState } from '../../store/app';
import {
  BUILD_STEPS,
  DraftPreview,
  EMPTY_EDIT,
  fromBuildDraft,
  type DraftEdit,
} from './buildDraft';
import { FormErrorNote, Pill } from '../shared/components';
import {
  FORM_LABEL_CLASS,
  FORM_ROW_CLASS,
  LINE_CLASS,
  MUTED_CLASS,
  PANEL_CARD_CLASS,
} from '../shared/styles';

/** ================================== 类型 ================================== */

/**
 * 新增页跳转的 location.state 形状：初值由跳转方携带（构建会话自动跳转 /
 * 列表「待加入角色」= ai；列表「新增角色」不带 state = choose），页内
 * choose/ai/manual 三态切换不再走路由（docs/44 44.2.1 路由表注记）。
 */
export interface RosterAddLocationState {
  addMode?: 'choose' | 'ai' | 'manual';
}

/** 工作台入参（build 会话快照由宿主页的 useBuildSession 传入——轮询在那里挂）。 */
export interface BuildWorkbenchProps {
  /** 构建会话快照（null=无会话；store build.session 的直读值）。 */
  build: BuildSession | null;
  /** 新增页当前方式——已放弃续跑卡只在 ai 态出现（拆分前同条件）。 */
  addMode: 'choose' | 'ai' | 'manual';
  /** 确认入库成功回执：回拉名册并返回角色列表（原 setView('list') 链）。 */
  onConfirmed: () => void;
}

/** ================================== 样式类 ================================== */

/** 原 styles.buildStep（构建工作台步骤行）；原 prefillBanner docs/23 S23-3
 * 迁移 shadcn Alert（default 变体 + 品牌淡底覆盖），常量删除。
 * D22d：步骤行 14px/24、序号圆牌 12px。 */
const BUILD_STEP_CLASS = 'flex items-center gap-2 py-0.5 text-sm leading-6';

/** ================================== 常量与映射表 ================================== */

/**
 * 已消费「待确认」侧效应的会话键（模块级单例，原 seenReviewRef——生命周期
 * 依据见文件头）：用户手动离开后不反复强拉，状态再迁移（新会话 startedAt）
 * 才再次跳转/复位。
 */
let SEEN_REVIEW_STARTED_AT = 0;

/** ================================== 工具函数 ================================== */

/** （rollAvatarPair 已随 M7-2 收口 components/avatarRing.tsx——本件与
 * roster 两页共借组件件的同名导出。） */

/** ================================== 事件处理 ================================== */

/**
 * 构建会话订阅与轮询（原 membersTab 的 refreshBuild + 会话侧效应，M2 拆页
 * 收口）：roster 域三个路由页各挂一轮——同屏只挂载一页，等效原「角色 tab
 * 活跃期单轮询」；路由卸载即清 interval，与原离开角色 tab 一致。
 *
 * 侧效应（原 useEffect 内联逻辑，零行为变更）：待确认草稿到达时以 startedAt
 * 为会话键去重自动跳转（docs/19.16）。不在新增页 → navigate 落新增页 ai 态；
 * 已在新增页 → 触发 onAwaitingConfirmation（原 setAddMode('ai') 模式复位——
 * 导航无处可去，复位交给宿主页）。
 */
export function useBuildSession(onAwaitingConfirmation?: () => void): BuildSession | null {
  const dispatch = useDispatch();
  const build = useSelector((s: RootState) => s.build.session);
  const navigate = useNavigate();
  const location = useLocation();
  // 回调经 ref 透传：effect 消费最新闭包且不进依赖数组（回调 identity 每渲染
  // 都变，进依赖会让去重效应空转）。
  const onAwaitingRef = useRef(onAwaitingConfirmation);
  useEffect(() => {
    onAwaitingRef.current = onAwaitingConfirmation;
  });
  const refreshBuild = useCallback((): void => {
    // S10：直接 await api 的调用点改 dispatch；失败由 effect 落 state.error
    // ——迁移前这里 .catch(() => undefined) 同为静默面。
    void dispatch({ type: 'build/fetchBuild' });
  }, [dispatch]);
  useEffect(() => {
    if (build === null) return;
    // 新会话不再强制跳创建页（docs/19.16）：发送时刻由对话卡片负责
    // openMemberBuilder——强跳会把用户每次回面板都拽进 add 视图，导致
    // 「构建时进不去对话/看板」。（原 seenSessionRef 分支随该决策成空壳，
    // 拆页时删除。）
    if (build.status === 'awaiting_confirmation' && SEEN_REVIEW_STARTED_AT !== build.startedAt) {
      SEEN_REVIEW_STARTED_AT = build.startedAt;
      // AI 创建流（用户迭代 2026-09-03）：草稿确认态属于 AI 创建路径，自动
      // 跳转时顺带把新增页切到 ai 模式，避免回落到方式选择页。
      if (location.pathname !== '/roster/add') {
        navigate('/roster/add', {
          state: { addMode: 'ai' } satisfies RosterAddLocationState,
        });
      } else {
        onAwaitingRef.current?.();
      }
    }
  }, [build, location.pathname, navigate]);
  // 1.5s 订阅轮询（M7-8）：挂载即拉一次 + interval 重拉 + 卸载清理，收口
  // usePoll（refreshBuild 是 useCallback([dispatch]) 稳定身份，语义不变）。
  usePoll(refreshBuild, 1500);
  return build;
}

/** ================================== 主组件 ================================== */

/**
 * 构建工作台渲染面：active（构建中：图标/标题行 + 访谈去向提示 + 步骤时间线
 * + 草稿预览）、awaiting_confirmation（草稿确认表单：头像行 + 角色名 + 手册
 * 编辑器 + 确认/放弃）、cancelled（已放弃续跑卡，仅 AI 创建页且父会话在线）。
 * 由 rosterAddPage 挂在方式内容之前——三段互斥渲染与拆分前逐位一致。
 */
export function BuildWorkbench({ build, addMode, onConfirmed }: BuildWorkbenchProps): ReactNode {
  const dispatch = useDispatch();
  const [draftEdit, setDraftEdit] = useState<DraftEdit>(EMPTY_EDIT);
  const [confirming, setConfirming] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // AI 草稿确认页「随机头像」（用户迭代 2026-09-04）：换过的头像对仅本地
  // 预览——确认入库时随 payload 透传，未换过则沿用构建师定的原对。
  const [draftAvatarRoll, setDraftAvatarRoll] = useState<{ seed: number; salt: number } | null>(
    null,
  );
  const draftInitRef = useRef(0);
  const refreshBuild = useCallback((): void => {
    // 与 useBuildSession 同款单发（确认/放弃/续跑/重启的 finally 收尾位）。
    void dispatch({ type: 'build/fetchBuild' });
  }, [dispatch]);

  // 待确认草稿到达/刷新时重置编辑表单（对话里继续调整 → 表单跟着刷新）；
  // 新草稿到达（或对话里调整后刷新）：换过的头像覆盖作废，回到构建师定的对。
  useEffect(() => {
    if (build === null) return;
    if (
      build.status === 'awaiting_confirmation' &&
      build.draft !== null &&
      build.updatedAt !== draftInitRef.current
    ) {
      draftInitRef.current = build.updatedAt;
      setDraftEdit(fromBuildDraft(build.draft));
      setDraftAvatarRoll(null);
    }
  }, [build]);

  /* —— 事件处理 —— */

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
          // 名字即身份（与手动创建同口径）：角色输入框已撤（用户反馈
          // 2026-09-05「去掉角色名下面的角色输入框」），role 空时随名回填
          // ——host 契约要求非空 role。
          role: draftEdit.role.trim() !== '' ? draftEdit.role.trim() : draftEdit.name.trim(),
          profile: draftEdit.profile.trim(),
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
      // 已入库卡下线（用户迭代 2026-09-04）：确认成功即回列表——直接跳角色
      // 列表（用户反馈 2026-09-05）：入库后用户要看的是新角色落进列表，不是
      // 方式选择页——与手动创建保存后同款落点（原 setAddMode('choose')/
      // setAiPrefill(null)/setView('list') 链收进 onConfirmed，页面卸载后
      // 页内态复位无需显式清）。
      onConfirmed();
    } catch (e) {
      setFormError(errorMessageOf(e));
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
      setResumeError(errorMessageOf(e));
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
      setInterviewError(errorMessageOf(e));
    }
    setConfirming(false);
    refreshBuild();
  };

  // AI 草稿确认页生效头像（用户迭代 2026-09-04）：换过取换后的，否则取
  // 构建师定的原对——页头小像与表单头像行同源，不会各显各的。
  const draftAvatarPair =
    draftAvatarRoll ?? (build !== null && build.draft !== null ? build.draft.avatar : undefined);
  // 访谈未答 = 持续构建子代理按设计已收束回合，此刻在等用户——显示「等你作答」
  // 而不是转圈的「工作中」，否则看起来像卡死（显示状态要诚实）。
  const interviewWaiting =
    build !== null &&
    build.status === 'active' &&
    build.interview !== undefined &&
    build.interview.answers === undefined;

  return (
    <>
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
            {interviewWaiting ? <Pill tone="warn">等你作答</Pill> : <Pill tone="info">构建中</Pill>}
            <span className="flex-1" />
            {interviewWaiting && (
              <Button
                size="sm"
                disabled={confirming}
                onClick={() => void restartBuildAgent()}
                title="不答题，直接唤醒构建代理重新核查进度并按需重新出题"
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
                问题已发到发起 /eteam
                的对话——回到主会话，在弹出的选择框里逐题作答，答完构建自动继续。没看到选择框？点「重启代理」重新出题。
              </div>
              {interviewError !== null && (
                <div className="mt-2 text-xs leading-5 text-destructive">⚠️ {interviewError}</div>
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
                  <StepGlyph state={glyphState} className="font-semibold" />
                  <span className={done || current ? 'text-foreground' : 'text-muted-foreground'}>
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
            草稿已就绪——可直接修改，确认后入库
          </div>
          {formError !== null && <FormErrorNote>{formError}</FormErrorNote>}
          {/* 头像行（用户迭代 2026-09-04）：预览 + 随机换一枚，与下方
          角色名/手册同一表单节奏（label 在上、控件在下）。页头标题旁的
          头像已撤（用户反馈 2026-09-05）——下方头像行就是它的去处。 */}
          <div className={cn(FORM_ROW_CLASS, 'mt-2')}>
            <span className={FORM_LABEL_CLASS}>头像</span>
            <div className="flex items-center gap-2.5">
              {/* 头像 + 随机换一枚（描边环已撤——用户迭代 2026-09-07，
              描边统一走 Avatar 默认 1px 深灰框）。 */}
              <Avatar
                name={draftEdit.name.trim() !== '' ? draftEdit.name.trim() : build.draft.name}
                seed={draftAvatarPair?.seed}
                salt={draftAvatarPair?.salt}
                size={40}
              />
              <RandomAvatarButton onRoll={() => setDraftAvatarRoll(rollAvatarPair())} />
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
            <span className={FORM_LABEL_CLASS}>简介（一句话，展示在角色列表卡片上）</span>
            <Input
              value={draftEdit.profile}
              onChange={(e) => setDraftEdit({ ...draftEdit, profile: e.target.value })}
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
              disabled={confirming || draftEdit.name.trim() === ''}
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
            {build.request !== '' && <div className={MUTED_CLASS}>需求：{build.request}</div>}
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
    </>
  );
}
