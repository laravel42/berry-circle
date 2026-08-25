'use client';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import {
   resolveOrder,
   SidebarBadgeStyle,
   SidebarItemKey,
   SidebarSection,
   SidebarVisibility,
   useSidebarPrefsStore,
} from '@/store/sidebar-prefs-store';
import {
   Activity,
   BarChart3,
   Box,
   Check,
   ChevronDown,
   FolderKanban,
   GitPullRequest,
   GripVertical,
   Inbox,
   LucideIcon,
   MessageSquare,
   RefreshCw,
   Sparkles,
   Video,
} from 'lucide-react';
import { Fragment, useRef, useState, type PointerEvent } from 'react';

interface ItemConfig {
   key: SidebarItemKey;
   label: string;
   icon: LucideIcon;
   /** Items with a badge get the "Show when badged" option. */
   badged?: boolean;
}

export const PERSONAL_ITEMS: ItemConfig[] = [
   { key: 'inbox', label: 'inbox', icon: Inbox, badged: true },
   { key: 'reviews', label: 'reviews', icon: GitPullRequest },
   { key: 'chat', label: 'chat', icon: MessageSquare },
   { key: 'meetings', label: 'meetings', icon: Video },
];

export const WORKSPACE_ITEMS: ItemConfig[] = [
   { key: 'my-issues', label: 'issues', icon: FolderKanban },
   { key: 'autopilot', label: 'autopilot', icon: RefreshCw },
   { key: 'analytics', label: 'analytics', icon: BarChart3 },
   { key: 'projects', label: 'projects', icon: Box },
];

export const CONFIGURE_ITEMS: ItemConfig[] = [
   { key: 'agent', label: 'runtimes', icon: Activity },
   { key: 'agents', label: 'agents', icon: Sparkles },
];

const VISIBILITY_LABELS: Record<SidebarVisibility, string> = {
   always: 'Always show',
   badged: 'Show when badged',
   never: "Don't show",
};

function VisibilityDropdown({
   value,
   options,
   onChange,
}: {
   value: SidebarVisibility;
   options: SidebarVisibility[];
   onChange: (value: SidebarVisibility) => void;
}) {
   return (
      <DropdownMenu>
         <DropdownMenuTrigger className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors outline-none">
            {VISIBILITY_LABELS[value]}
            <ChevronDown className="size-3.5" />
         </DropdownMenuTrigger>
         <DropdownMenuContent align="end" className="min-w-44">
            {options.map((option) => (
               <DropdownMenuItem key={option} onClick={() => onChange(option)}>
                  {VISIBILITY_LABELS[option]}
                  {value === option && <Check className="ml-auto size-3.5" />}
               </DropdownMenuItem>
            ))}
         </DropdownMenuContent>
      </DropdownMenu>
   );
}

/** Insertion marker: a single red rule on the boundary between items. */
function DropZone({ show }: { show: boolean }) {
   return (
      <div
         aria-hidden={!show}
         className={cn(
            'pointer-events-none relative z-10 h-0',
            show ? 'opacity-100' : 'opacity-0'
         )}
      >
         <div className="absolute inset-x-0 -top-px h-0.5 bg-[var(--shell-accent)]" />
      </div>
   );
}

/** One section (Personal / Workspace / Configure): rows reorderable by dragging the grip. */
function ItemSection({ section, items }: { section: SidebarSection; items: ItemConfig[] }) {
   const { visibility, order, setVisibility, moveItem } = useSidebarPrefsStore();
   const [dragIndex, setDragIndex] = useState<number | null>(null);
   const [insertAt, setInsertAt] = useState<number | null>(null);
   const listRef = useRef<HTMLDivElement>(null);
   const fromRef = useRef<number | null>(null);
   const insertRef = useRef<number | null>(null);

   const orderedKeys = resolveOrder(
      order[section],
      items.map((item) => item.key)
   );
   const ordered = orderedKeys
      .map((key) => items.find((item) => item.key === key))
      .filter((item): item is ItemConfig => Boolean(item));

   const resetDrag = () => {
      fromRef.current = null;
      insertRef.current = null;
      setDragIndex(null);
      setInsertAt(null);
   };

   // Native HTML5 drag-and-drop does not fire drop inside a transformed
   // Radix dialog, so reorder is pointer-driven from the grip instead.
   // Midpoint hit-testing yields an insertion slot (0..length), not a row.
   const slotFromY = (clientY: number) => {
      const root = listRef.current;
      if (!root) return null;
      const rows = root.querySelectorAll<HTMLElement>('[data-reorder-row]');
      for (let i = 0; i < rows.length; i++) {
         const rect = rows[i].getBoundingClientRect();
         if (clientY < rect.top + rect.height / 2) return i;
      }
      return rows.length;
   };

   const isNoopSlot = (from: number, slot: number) => slot === from || slot === from + 1;

   const onGripPointerDown = (index: number) => (event: PointerEvent<HTMLSpanElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      fromRef.current = index;
      insertRef.current = index;
      setDragIndex(index);
      setInsertAt(index);
   };

   const onGripPointerMove = (event: PointerEvent<HTMLSpanElement>) => {
      if (fromRef.current === null) return;
      const next = slotFromY(event.clientY);
      if (next === null || next === insertRef.current) return;
      insertRef.current = next;
      setInsertAt(next);
   };

   const onGripPointerUp = () => {
      const from = fromRef.current;
      const slot = insertRef.current;
      if (from !== null && slot !== null && !isNoopSlot(from, slot)) {
         moveItem(section, from, from < slot ? slot - 1 : slot);
      }
      resetDrag();
   };

   const dragging = dragIndex !== null;
   const dropSlot =
      dragging && insertAt !== null && !isNoopSlot(dragIndex, insertAt) ? insertAt : null;
   const liveLabel =
      dropSlot === null || dragIndex === null
         ? undefined
         : dropSlot === 0
           ? `Drop ${ordered[dragIndex].label} at the start`
           : dropSlot === ordered.length
             ? `Drop ${ordered[dragIndex].label} at the end`
             : `Drop ${ordered[dragIndex].label} before ${ordered[dropSlot].label}`;

   return (
      <div
         ref={listRef}
         className={cn('rounded-lg border', dragging && 'cursor-grabbing select-none')}
      >
         <div className="sr-only" aria-live="polite">
            {liveLabel}
         </div>
         {ordered.map((item, index) => {
            const current = visibility[item.key] ?? 'always';
            const options: SidebarVisibility[] = item.badged
               ? ['always', 'badged', 'never']
               : ['always', 'never'];
            return (
               <Fragment key={item.key}>
                  <DropZone show={dropSlot === index} />
                  <div
                     data-reorder-row
                     className={cn(
                        'flex items-center gap-2 px-3 py-2.5',
                        index < ordered.length - 1 && 'border-b border-border/60',
                        dragIndex === index && 'opacity-40 ring-1 ring-inset ring-[var(--shell-accent)]'
                     )}
                  >
                     <span
                        data-reorder-handle
                        onPointerDown={onGripPointerDown(index)}
                        onPointerMove={onGripPointerMove}
                        onPointerUp={onGripPointerUp}
                        onPointerCancel={resetDrag}
                        className="cursor-grab touch-none active:cursor-grabbing text-muted-foreground/50 hover:text-muted-foreground shrink-0 [&_svg]:pointer-events-none"
                        aria-label={`Reorder ${item.label}`}
                     >
                        <GripVertical className="size-3.5" />
                     </span>
                     <item.icon
                        className={cn(
                           'size-4 shrink-0',
                           current === 'never' && 'text-muted-foreground/50'
                        )}
                     />
                     <span
                        className={cn('flex-1', current === 'never' && 'text-muted-foreground/60')}
                     >
                        {item.label}
                     </span>
                     <VisibilityDropdown
                        value={current}
                        options={options}
                        onChange={(value) => setVisibility(item.key, value)}
                     />
                  </div>
               </Fragment>
            );
         })}
         <DropZone show={dropSlot === ordered.length} />
      </div>
   );
}

/** Linear-style "Customize sidebar" modal (badge style, visibility, drag & drop order). */
export function CustomizeSidebarDialog({
   open,
   onOpenChange,
}: {
   open: boolean;
   onOpenChange: (open: boolean) => void;
}) {
   const { badgeStyle, setBadgeStyle } = useSidebarPrefsStore();

   return (
      <Dialog open={open} onOpenChange={onOpenChange}>
         <DialogContent className="sm:max-w-md p-0 gap-0">
            <DialogHeader className="px-5 pt-5 pb-3">
               <DialogTitle>Customize sidebar</DialogTitle>
            </DialogHeader>
            <div className="px-5 pb-5 flex flex-col gap-5 overflow-y-auto max-h-[70vh]">
               <div className="flex items-center justify-between rounded-lg border px-3 py-2.5">
                  <span>Default badge style</span>
                  <DropdownMenu>
                     <DropdownMenuTrigger className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors outline-none">
                        {badgeStyle === 'count' ? (
                           <span className="bg-accent rounded px-1">1</span>
                        ) : (
                           <span className="size-1.5 rounded-full bg-muted-foreground inline-block" />
                        )}
                        {badgeStyle === 'count' ? 'Count' : 'Dot'}
                        <ChevronDown className="size-3.5" />
                     </DropdownMenuTrigger>
                     <DropdownMenuContent align="end" className="min-w-32">
                        {(['count', 'dot'] as SidebarBadgeStyle[]).map((style) => (
                           <DropdownMenuItem key={style} onClick={() => setBadgeStyle(style)}>
                              {style === 'count' ? 'Count' : 'Dot'}
                              {badgeStyle === style && <Check className="ml-auto size-3.5" />}
                           </DropdownMenuItem>
                        ))}
                     </DropdownMenuContent>
                  </DropdownMenu>
               </div>

               <div className="flex flex-col gap-2">
                  <span className="font-medium">Personal</span>
                  <ItemSection section="personal" items={PERSONAL_ITEMS} />
               </div>

               <div className="flex flex-col gap-2">
                  <span className="font-medium">Workspace</span>
                  <ItemSection section="workspace" items={WORKSPACE_ITEMS} />
               </div>

               <div className="flex flex-col gap-2">
                  <span className="font-medium">Configure</span>
                  <ItemSection section="configure" items={CONFIGURE_ITEMS} />
               </div>
            </div>
         </DialogContent>
      </Dialog>
   );
}
