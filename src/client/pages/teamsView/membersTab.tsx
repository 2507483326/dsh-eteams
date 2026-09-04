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
import MessageSquare from 'lucide-react/dist/esm/icons/message-square.mjs';
import PenLine from 'lucide-react/dist/esm/icons/pen-line.mjs';
import {
  IconCheckOutline16,
  IconPlusOutline16,
  IconSparkle16,
  MarkdownText,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { ADD_PEOPLE_TEMPLATE, type PrefillOutcome } from '../../lib/addPeople';
import { activateConversationTab } from '../../lib/bridge';
import type { InterviewQuestion, RosterMember } from '../../lib/api';
import type { TeamSnapshot } from '../../lib/monitor';
import { cn } from '../../lib/cn';
import { Avatar } from '../../features/avatar/avatar';
import { MdEditor } from '../../features/mdEditor/mdEditor';
import { Alert } from '../../components/ui/alert';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { useDispatch, useSelector, type RootState } from '../../store/app';
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
import {
  BORDER_L1_CLASS,
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
  ROLE_LIST_CSS,
  SECTION_TITLE_CLASS,
  memberRank,
} from './shared';