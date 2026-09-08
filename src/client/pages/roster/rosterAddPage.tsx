/**
 * 角色新增工作台页（docs/13.3 / docs/19.9.5）：方式选择（choose）/ AI 创建
 * （ai）/ 手动创建（manual）三态留页内，构建会话面板（构建中/草稿确认/
 * 已放弃续跑）由 BuildWorkbench 承载——自 membersTab 拆出（docs/44 M2，
 * 行为零变更），路由 /roster/add。
 *
 * 初值经 location.state 携带（形状见 buildWorkbench RosterAddLocationState）：
 * 构建会话自动跳转与列表「待加入角色」带 ai，「新增角色」不带 state 落
 * choose——页内三态切换不再走路由（docs/44 44.2.1）。
 *
 * @module dsh-eteams/client/pages/roster/rosterAddPage
 */
import { useState, type ReactNode } from 'react';
import { useDispatch } from 'react-redux';
import { useLocation, useNavigate } from 'react-router-dom';
import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right.mjs';
import PenLine from 'lucide-react/dist/esm/icons/pen-line.mjs';
import {
  IconPlusOutline16,
  IconSparkle16,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { ADD_PEOPLE_TEMPLATE, type PrefillOutcome } from '../../lib/addPeople';
import type { RosterMember } from '../../lib/api';
import { cn } from '../../lib/cn';
import { errorMessageOf } from '../../lib/errors';
import { MdEditor } from '../../features/mdEditor/mdEditor';
import { Avatar } from '../../features/avatar/avatar';
import { RandomAvatarButton, rollAvatarPair } from '../../components/avatarRing';
import { Alert } from '../../components/ui/alert';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { CommandChip, PREFILL_STEPS } from './buildDraft';
import { FormErrorNote, Pill } from '../shared/components';
import {
  FORM_LABEL_CLASS,
  FORM_ROW_CLASS,
  LINE_CLASS,
  MUTED_CLASS,
  PANEL_CARD_CLASS,
  TEXT2_CLASS,
} from '../shared/styles';
import { BuildWorkbench, useBuildSession, type RosterAddLocationState } from './buildWorkbench';

/** ================================== 类型 ================================== */

/** 路由页入参（壳状态经 routes.tsx 传入，数据流与拆分前逐位一致）。 */
export interface RosterAddPageProps {
  /** 角色库（手动创建的同名拦截用，store roster.list 经壳传入）。 */
  members: RosterMember[];
  /** 保存回拉（roster/fetchRoster）。 */
  onDeleted: () => void;
  /** 一键预填 composer（'set'/'copied'/'aborted'）。 */
  onPrefillAddPeople: () => PrefillOutcome;
}

/** ================================== 样式类 ================================== */

/** 新增角色方式选择卡（choose 态，用户迭代 2026-09-03）：整行可点（图标 +
 * 标题 + 描述 + 右箭头）；底色/边框/悬停同角色卡片走 .eteams-role-row。 */
const ADD_MODE_CARD_CLASS =
  'flex w-full cursor-pointer items-center gap-3 rounded-xl p-4 text-left text-foreground';
/** 方式选择卡图标底（品牌淡底圆牌，STEP_NUM_CLASS 同口径放大到 32px）。 */
const ADD_MODE_ICON_CLASS =
  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-business-tint text-primary';
/** 原 styles.stepRow / stepNum（AI 创建预填引导三步；原 prefillBanner
 * docs/23 S23-3 迁移 shadcn Alert，常量删除）。
 * D22d：步骤行 14px/24、序号圆牌 12px。 */
const STEP_ROW_CLASS = `mt-2 flex items-start gap-2 text-sm leading-6 ${TEXT2_CLASS}`;
const STEP_NUM_CLASS =
  'mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-business-tint text-xs font-semibold text-[color:var(--eteams-brand-ink)]';

/** ================================== 主组件 ================================== */

/**
 * 新增工作台：顶部返回条 + 一张面板卡——卡内先是构建会话工作台（有会话时），
 * 随后按会话状态与 addMode 渲染方式内容（手动表单 / AI 预填引导 / 方式选择
 * 卡），与拆分前 membersTab add 视图的卡内顺序逐位一致。
 */
export function RosterAddPage({
  members,
  onDeleted,
  onPrefillAddPeople,
}: RosterAddPageProps): ReactNode {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const location = useLocation();
  // 新增方式（用户迭代 2026-09-03）：进入新增页先选「手动创建 / AI 创建」，
  // 不再默认把命令填进对话输入框——点「AI 创建」此刻才预填，手动创建直接
  // 进角色手册编辑页。初值由跳转方经 location.state 携带（见文件头）。
  const initialAddMode = (location.state as RosterAddLocationState | null)?.addMode;
  const [addMode, setAddMode] = useState<'choose' | 'ai' | 'manual'>(initialAddMode ?? 'choose');
  // AI 创建的预填结果（'set' 填入输入框 / 'copied' 退化剪贴板 / 'aborted'
  // 用户取消覆盖），驱动 AI 创建页的状态行。
  const [aiPrefill, setAiPrefill] = useState<PrefillOutcome | null>(null);
  const [name, setName] = useState('');
  // 一句话简介（用户迭代 2026-09-06）：列表卡片/详情头展示，可留空。
  const [profile, setProfile] = useState('');
  const [personaMd, setPersonaMd] = useState('');
  // 手动创建（用户迭代 2026-09-03）：面板直连名册保存（`roster/saveRoster`
  // → POST /roster，与详情页 HandbookEditor 同一写路径），不再借对话命令
  // 中转。角色不再单独收集（用户反馈：名字即身份）——host 要求非空 role，
  // 随名回填；personaMd 留空则手册随后可在详情页补写。
  const [manualSaving, setManualSaving] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  // 手动创建「随机头像」（用户迭代 2026-09-04）：进页即随机一枚预览，按钮
  // 随时再换；保存时随 payload 落库（roster.ts upsert）。
  const [manualAvatar, setManualAvatar] = useState<{ seed: number; salt: number } | null>(null);
  // 构建会话轮询 + 待确认模式复位（见 buildWorkbench useBuildSession）。
  const build = useBuildSession((): void => setAddMode('ai'));

  /* —— 事件处理 —— */

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
  // 复制静默收口（用户反馈 2026-09-08「不需要弹」）：writeClipboard 写入
  // 剪贴板即止，不再弹任何反馈——右下角弹框整体撤除。
  const copyTemplate = (): void => {
    void writeClipboard(ADD_PEOPLE_TEMPLATE).catch(() => undefined);
  };

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
          ...(profile.trim() !== '' ? { profile: profile.trim() } : {}),
          ...(personaMd.trim() !== '' ? { personaMd } : {}),
          ...(manualAvatar !== null ? { avatar: manualAvatar } : {}),
        },
      });
      // 保存成功 → 父级重拉名册，返回角色列表即见新角色（原 setName('')/
      // setPersonaMd('')/setManualAvatar(null)/setAddMode('choose') 复位随
      // 页面卸载一并失效，无需显式清）。
      onDeleted();
      navigate('/roster');
    } catch (e) {
      setManualError(errorMessageOf(e));
    } finally {
      setManualSaving(false);
    }
  };

  // 确认入库成功落点（BuildWorkbench 回执）：原 setAddMode('choose')/
  // setAiPrefill(null)/onDeleted()/setView('list') 链——页内复位随卸载失效，
  // 保留回拉名册 + 返回角色列表两个有效位。
  const confirmDone = (): void => {
    onDeleted();
    navigate('/roster');
  };

  return (
    <div className="min-w-0 overflow-x-hidden">
      <style>{'@keyframes eteams-spin{to{transform:rotate(360deg)}}'}</style>
      {/* 返回钮走壳层页头 onBack（用户迭代 2026-09-08：页面返回统一收口
      PageHeader onBack 槽，页头行最右图标钮）——顶部返回条行撤，卡直接跟页头。 */}
      <Card className={cn(PANEL_CARD_CLASS)}>
        <BuildWorkbench build={build} addMode={addMode} onConfirmed={confirmDone} />
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
                  {/* 头像 + 随机换一枚（描边环已撤——用户迭代 2026-09-07，
                  描边统一走 Avatar 默认 1px 深灰框）。 */}
                  <Avatar
                    name={name}
                    seed={manualAvatar?.seed}
                    salt={manualAvatar?.salt}
                    size={40}
                  />
                  <RandomAvatarButton onRoll={() => setManualAvatar(rollAvatarPair())} />
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
                <span className={FORM_LABEL_CLASS}>简介（一句话，展示在角色列表卡片上，可留空）</span>
                <Input
                  value={profile}
                  placeholder="如：负责后端接口与数据库调优"
                  onChange={(e) => setProfile(e.target.value)}
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
              钮就都消失了」）：填充成功不再收走按钮行——复制仍随时可用。 */}
              <div className="mt-2.5 flex items-center gap-2">
                <Button size="sm" onClick={prefillAi}>
                  {aiPrefill === 'set' ? '重新填充' : '填充'}
                </Button>
                <Button size="sm" variant="secondary" onClick={copyTemplate}>
                  复制
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
