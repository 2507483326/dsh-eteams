/**
 * 成员汇报时间线（docs/13.3 汇报）：成员对话框记录只读列表（M5 开放直发）。
 * 符号自 eteamsView.tsx 原样搬出（docs/32 32.5.1 纯移动、零行为变更），
 * 供 membersTab / reportsTab 消费（依赖方向：membersTab/reportsTab → memberDialog → shared）。
 *
 * @module dsh-eteams/client/pages/teamsView/memberDialog
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { MemberView, TeamSnapshot } from '../../lib/monitor';
import { MUTED_CLASS } from './shared';