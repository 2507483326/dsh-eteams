/**
 * 角色列表页（docs/13.3 角色库 / D16）：搜索/分页/删除 + 新增入口——自
 * membersTab 拆出（docs/44 M2，行为零变更），路由 /roster。构建会话经
 * {@link useBuildSession} 轮询（仅角色域活跃时跑）：有未入库草稿时新增入口
 * 让位「待加入角色」，待确认草稿到达自动跳新增页。
 *
 * @module dsh-eteams/client/pages/roster/rosterPage
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useDispatch } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { IconPlusOutline16 } from '@deepseek-ai/dsh-client-ui-primitives';
import type { RosterMember } from '../../lib/api';
import { cn } from '../../lib/cn';
import { errorMessageOf } from '../../lib/errors';
import { Avatar } from '../../features/avatar/avatar';
import { DeleteButton } from '../../components/deleteButton';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { ListPagination } from '../../components/listPagination';
import type { RosterAddLocationState } from './buildWorkbench';
import { useBuildSession } from './buildWorkbench';
import { FormErrorNote } from '../shared/components';
import {
  CARD_GRID_CLASS,
  EMPTY_CLASS,
  LIST_COUNT_CLASS,
  LIST_TITLE_CLASS,
  PANEL_CARD_CLASS,
  PROTECTED_MEMBERS,
  memberRank,
} from '../shared/styles';

/** ================================== 类型 ================================== */

/** 路由页入参（壳状态经 routes.tsx 传入，数据流与拆分前逐位一致）。 */
export interface RosterPageProps {
  /** 角色库（store roster.list 经壳传入）。 */
  members: RosterMember[];
  /** 删除回拉（roster/fetchRoster）。 */
  onDeleted: () => void;
  /** 创建卡片跳转信号（>0 打开新增工作台，docs/19.9.5）。 */
  openAddTick: number;
  /** 信号消费回执（壳清零 openAddTick）。 */
  onAddTickConsumed: () => void;
}

/** ================================== 样式类 ================================== */

/** 原 styles.roleCard（底色/边框/悬停由 .eteams-role-row 样式表接管）；
 * p-4 = D22f 卡内呼吸感。用户迭代 2026-09-03：改一行式横排——头像在前、
 * 名称（与所属团队）随后、删除钮常驻行尾（不再 hover 显形）。 */
const ROLE_CARD_CLASS =
  'flex min-w-0 cursor-pointer items-center gap-2.5 rounded-xl p-4 text-left text-foreground';

/** ================================== 常量与映射表 ================================== */

/** 角色列表每页条数（原组件内常量，用户反馈口径 25 条/页）。 */
const MEMBER_PAGE_SIZE = 25;

/** ================================== 主组件 ================================== */

/**
 * 角色列表：页头（标题 + 计数 + 搜索框 + 新增入口）→ 错误条/空态 → 角色卡片
 * 栅格 → 分页。详情/新增导航走 useNavigate（:name 路由参数即角色名）。
 */
export function RosterPage({
  members,
  onDeleted,
  openAddTick,
  onAddTickConsumed,
}: RosterPageProps): ReactNode {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const [listError, setListError] = useState<string | null>(null);
  // 角色列表搜索 + 分页（用户反馈）：按名字/角色字段过滤，每页 8 条。
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  // 构建会话（docs/19.6.2, D18-5）：S10 迁入 build model——session 经
  // useBuildSession 读取，轮询由它发 `build/fetchBuild`（仅角色域活跃时跑）；
  // 待确认草稿到达时以会话键去重自动跳新增页（见 buildWorkbench）。
  const build = useBuildSession();

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

  /* —— 事件处理 —— */

  // 创建卡片跳转（docs/19.9.5）：父级消费制——滞留信号曾让重进角色页时
  // 自动跳进新增工作台；tick 归零后复位 lastAddTickRef。
  const lastAddTickRef = useRef(0);
  useEffect(() => {
    if (openAddTick === 0) {
      lastAddTickRef.current = 0;
      return;
    }
    if (openAddTick !== lastAddTickRef.current) {
      lastAddTickRef.current = openAddTick;
      onAddTickConsumed();
      navigate('/roster/add', { state: { addMode: 'ai' } satisfies RosterAddLocationState });
    }
  }, [openAddTick, onAddTickConsumed, navigate]);

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
        // 错误规范化收口 errorMessageOf（M7-5；无 busy 槽——不套 runWithBusy）。
        setListError(errorMessageOf(e));
      }
    })();
  };

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
            <Button size="sm" onClick={() => navigate('/roster/add', { state: { addMode: 'ai' } })}>
              待加入角色
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => {
                // 用户迭代 2026-09-03：新增不再默认预填对话——先进新增页选
                // 「手动创建 / AI 创建」，点「AI 创建」才把命令填进输入框。
                navigate('/roster/add');
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
            名称随后、删除钮常驻行尾（不再 hover 显形）；
            hover/描边由 ROLE_LIST_CSS 接管。 */}
            <div className={CARD_GRID_CLASS}>
              {pageRows.map((m) => {
                const isProtected = PROTECTED_MEMBERS.includes(m.name);
                return (
                  <div
                    key={m.name}
                    className={cn('eteams-role-row', ROLE_CARD_CLASS)}
                    onClick={() => navigate(`/roster/${encodeURIComponent(m.name)}`)}
                  >
                    <Avatar name={m.name} seed={m.avatar?.seed} salt={m.avatar?.salt} size={40} />
                    {/* 角色（用户反馈）：不再需要标签——名字即身份；简介
                    （用户迭代 2026-09-06）跟在名字下一行，单行截断。 */}
                    <div className="min-w-0 flex-1">
                      <span className="eteams-role-name block max-w-full text-sm font-semibold text-foreground">
                        {m.name}
                      </span>
                      {m.profile !== undefined && m.profile.trim() !== '' && (
                        <span className="eteams-role-name mt-0.5 block max-w-full truncate text-xs leading-5 text-muted-foreground">
                          {m.profile.trim()}
                        </span>
                      )}
                    </div>
                    {isProtected ? null : (
                      /* 删除（M7-4 收口 components/deleteButton）：悬停红描边/
                      淡底为角色行特有档，className 透传；点击不冒泡进详情。 */
                      <DeleteButton
                        label="删除"
                        className="text-destructive hover:border-destructive hover:bg-[color:color-mix(in_srgb,var(--destructive)_6%,transparent)] hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          del(m.name);
                        }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
            {/* shadcn Pagination（2026-09-06 用户拍板「分页照官方 base/pagination
            样式还原」）：组装收口 listPagination（ListPagination）——上一页/
            下一页内嵌箭头 + 页码窗口（outline 激活档），各列表页统一走它；
            totalPages ≤ 1 组件自不渲染，页内免守卫。 */}
            <ListPagination page={safePage} totalPages={totalPages} onChange={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
