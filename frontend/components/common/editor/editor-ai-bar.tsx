'use client';

import { Button } from '@/components/ui/button';
import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { ArrowUp, Loader2, Sparkles } from 'lucide-react';

export const EDITOR_AI_PRESETS = [
   {
      id: 'improve',
      label: 'Improve writing',
      instruction: 'Improve clarity and flow while preserving meaning. Return Markdown only.',
   },
   {
      id: 'shorter',
      label: 'Make shorter',
      instruction: 'Make this shorter while keeping the key points. Return Markdown only.',
   },
   {
      id: 'expand',
      label: 'Expand',
      instruction: 'Expand with useful detail while staying concise. Return Markdown only.',
   },
   {
      id: 'fix',
      label: 'Fix grammar',
      instruction: 'Fix grammar, spelling, and punctuation. Return Markdown only.',
   },
] as const;

interface EditorAiBarProps {
   prompt: string;
   onPromptChange: (value: string) => void;
   onPreset: (instruction: string) => void;
   onSubmit: () => void;
   pending?: boolean;
   disabled?: boolean;
   className?: string;
}

/**
 * Floating TipTap-style AI prompt: sparkles, ask field, circular send.
 * Presets live behind the sparkles control so the bar stays one pill.
 */
export function EditorAiBar({
   prompt,
   onPromptChange,
   onPreset,
   onSubmit,
   pending = false,
   disabled = false,
   className,
}: EditorAiBarProps) {
   const busy = pending || disabled;
   const canSubmit = !busy && prompt.trim().length > 0;

   return (
      <div className={cn('pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center px-3', className)}>
         <div className="ai-prompt-pill pointer-events-auto shadow-[0_8px_30px_rgba(15,15,20,0.12)]">
            <div className="bg-popover flex h-11 w-full items-center gap-1 rounded-full px-1.5">
               <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                     <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground hover:text-foreground size-8 shrink-0 rounded-full"
                        aria-label="AI presets"
                        disabled={busy}
                     >
                        <Sparkles className="size-4" />
                     </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="min-w-44">
                     {EDITOR_AI_PRESETS.map((preset) => (
                        <DropdownMenuItem
                           key={preset.id}
                           disabled={busy}
                           onSelect={() => onPreset(preset.instruction)}
                        >
                           {preset.label}
                        </DropdownMenuItem>
                     ))}
                  </DropdownMenuContent>
               </DropdownMenu>

               <input
                  value={prompt}
                  onChange={(event) => onPromptChange(event.target.value)}
                  onKeyDown={(event) => {
                     if (event.key !== 'Enter' || event.shiftKey) return;
                     event.preventDefault();
                     if (!canSubmit) return;
                     onSubmit();
                  }}
                  placeholder="Ask about this document or request a change…"
                  disabled={busy}
                  aria-label="Ask AI"
                  className="placeholder:text-muted-foreground/70 min-w-0 flex-1 bg-transparent outline-none"
               />

               <Button
                  type="button"
                  size="icon"
                  disabled={!canSubmit}
                  aria-label={pending ? 'Working' : 'Send'}
                  onClick={() => {
                     if (!canSubmit) return;
                     onSubmit();
                  }}
                  className={cn(
                     'size-8 shrink-0 rounded-full',
                     canSubmit
                        ? 'bg-foreground text-background hover:bg-foreground/90'
                        : 'bg-muted text-muted-foreground'
                  )}
               >
                  {pending ? (
                     <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                     <ArrowUp className="size-3.5" />
                  )}
               </Button>
            </div>
         </div>
      </div>
   );
}
