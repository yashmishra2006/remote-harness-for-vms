import type { ReactNode } from 'react';

export default function PageShell({ title, onMenu, className, children }: { title: string; onMenu: () => void; className: string; children: ReactNode }) {
  return (
    <div className={`${className} safe-top min-w-0 flex-1 flex-col bg-canvas`}>
      <div className="flex items-center gap-3 border-b border-hairline px-4 py-3.5">
        <button onClick={onMenu} aria-label="Open menu" className="-ml-1 flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-surface-card md:hidden">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        <h2 className="text-[14px] font-medium text-ink">{title}</h2>
      </div>
      <div className="flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
