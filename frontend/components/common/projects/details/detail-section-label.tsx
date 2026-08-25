/** Shared section label for project/issue detail panels. */
export function DetailSectionLabel({ children }: { children: React.ReactNode }) {
   return (
      <div className="mb-1 pb-[7px] font-medium uppercase tracking-[0.14em] text-[var(--shell-text-dim)]">
         {children}
      </div>
   );
}
