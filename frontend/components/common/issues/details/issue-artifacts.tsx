'use client';

import { Button } from '@/components/ui/button';
import {
   ArtifactTreeNode,
   RunArtifact,
   buildArtifactTree,
   downloadArtifact,
   formatFileSize,
   loadIssueArtifacts,
} from '@/lib/attachments';
import { cn } from '@/lib/utils';
import { Bot, ChevronDown, ChevronRight, Download, FileCode2, Folder, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * What the agents on this issue produced, as the tree they wrote.
 *
 * Separate from the attachment list, and shaped differently, because it is a
 * different thing. A person uploads a file and it has a name; an agent builds
 * something and it has a structure — src/password/generator.ts beside
 * src/password/index.ts is a fact about the work, and flattening it to a list
 * of names throws that away.
 */
export function IssueArtifacts({ issueRef }: { issueRef: string }) {
   const [artifacts, setArtifacts] = useState<RunArtifact[]>([]);
   const [pending, setPending] = useState<string | null>(null);
   const [error, setError] = useState<string | null>(null);
   const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

   useEffect(() => {
      if (!issueRef) {
         setArtifacts([]);
         return;
      }
      let cancelled = false;
      void loadIssueArtifacts(issueRef)
         .then((loaded) => {
            if (!cancelled) setArtifacts(loaded);
         })
         .catch(() => {
            if (!cancelled) setArtifacts([]);
         });
      return () => {
         cancelled = true;
      };
   }, [issueRef]);

   const tree = useMemo(() => buildArtifactTree(artifacts), [artifacts]);

   const download = useCallback(async (artifact: RunArtifact) => {
      setPending(artifact.id);
      setError(null);
      try {
         await downloadArtifact(artifact);
      } catch {
         // Named rather than silent: a download that does nothing looks like a
         // broken button, and the file may simply no longer be there.
         setError(`${artifact.name} could not be downloaded.`);
      } finally {
         setPending(null);
      }
   }, []);

   const toggle = useCallback((path: string) => {
      setCollapsed((previous) => {
         const next = new Set(previous);
         if (next.has(path)) next.delete(path);
         else next.add(path);
         return next;
      });
   }, []);

   if (artifacts.length === 0) return null;

   const agents = [...new Set(artifacts.map((artifact) => artifact.agentName))].filter(Boolean);

   return (
      <div className="mt-6">
         <h3 className="mb-2 flex items-center gap-2 font-medium text-muted-foreground">
            <span>
               Produced ({artifacts.length} {artifacts.length === 1 ? 'file' : 'files'})
            </span>
            {agents.length > 0 ? (
               <span className="flex items-center gap-1 font-normal">
                  <Bot className="size-3.5" />
                  {agents.join(', ')}
               </span>
            ) : null}
         </h3>

         <div className="flex flex-col">
            {tree.map((node) => (
               <TreeRow
                  key={node.path}
                  node={node}
                  depth={0}
                  collapsed={collapsed}
                  onToggle={toggle}
                  onDownload={download}
                  pending={pending}
               />
            ))}
         </div>

         {error ? <p className="mt-2 text-destructive">{error}</p> : null}
      </div>
   );
}

function TreeRow({
   node,
   depth,
   collapsed,
   onToggle,
   onDownload,
   pending,
}: {
   node: ArtifactTreeNode;
   depth: number;
   collapsed: Set<string>;
   onToggle: (path: string) => void;
   onDownload: (artifact: RunArtifact) => void;
   pending: string | null;
}) {
   // Indent by nesting rather than by a computed class name, so Tailwind's
   // scanner sees every padding it has to emit.
   const indent = { paddingLeft: `${depth * 14}px` };

   if (node.file) {
      const artifact = node.file;
      return (
         <div
            className="flex min-w-0 items-center gap-2 border-b border-border/50 py-1.5"
            style={indent}
         >
            <FileCode2 className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{node.name}</span>
            <span className="shrink-0 text-muted-foreground">
               {formatFileSize(artifact.sizeBytes)}
            </span>
            <Button
               variant="ghost"
               size="icon"
               className={cn('ml-auto size-7 shrink-0')}
               aria-label={`Download ${artifact.path}`}
               title={artifact.path}
               disabled={pending === artifact.id}
               onClick={() => void onDownload(artifact)}
            >
               {pending === artifact.id ? (
                  <Loader2 className="size-4 animate-spin" />
               ) : (
                  <Download className="size-4" />
               )}
            </Button>
         </div>
      );
   }

   const isCollapsed = collapsed.has(node.path);
   return (
      <>
         <button
            type="button"
            onClick={() => onToggle(node.path)}
            aria-expanded={!isCollapsed}
            className="flex min-w-0 items-center gap-1.5 py-1.5 text-left hover:bg-sidebar/50"
            style={indent}
         >
            {isCollapsed ? (
               <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
               <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <Folder className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate font-medium">{node.name}</span>
            <span className="shrink-0 text-muted-foreground">{countFiles(node)}</span>
         </button>
         {isCollapsed
            ? null
            : node.children.map((child) => (
                 <TreeRow
                    key={child.path}
                    node={child}
                    depth={depth + 1}
                    collapsed={collapsed}
                    onToggle={onToggle}
                    onDownload={onDownload}
                    pending={pending}
                 />
              ))}
      </>
   );
}

function countFiles(node: ArtifactTreeNode): number {
   return node.children.reduce(
      (total, child) => total + (child.file ? 1 : countFiles(child)),
      0
   );
}
