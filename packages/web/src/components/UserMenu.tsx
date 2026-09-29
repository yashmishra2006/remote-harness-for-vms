import { useEffect, useRef, useState } from 'react';
import type { EscanorSession } from '../escanor/client';
import { useEscanor } from '../escanor/EscanorProvider';

export default function UserMenu({ session, onOpenSettings }: { session: EscanorSession | null; onOpenSettings: () => void }) {
  const { signOut } = useEscanor();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  const name = session?.user.name || session?.user.email || 'Hub user';
  const initial = name.trim().charAt(0).toUpperCase() || '?';

  return (
    <div ref={ref} className="relative border-t border-hairline p-2" style={{ paddingBottom: 'calc(0.5rem + env(safe-area-inset-bottom))' }}>
      {open && (
        <div className="absolute inset-x-2 bottom-full mb-1 overflow-hidden rounded-lg border border-hairline bg-canvas shadow-panel">
          {session && <p className="truncate border-b border-hairline px-3 py-2 text-[12px] text-muted-soft">{session.user.email}</p>}
          <button
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
            className="block w-full px-3 py-2.5 text-left text-[13px] text-body hover:bg-surface-card"
          >
            Settings
          </button>
          <button
            onClick={() => {
              setOpen(false);
              signOut();
            }}
            className="block w-full px-3 py-2.5 text-left text-[13px] text-error hover:bg-surface-card"
          >
            Sign out
          </button>
        </div>
      )}
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition hover:bg-surface-card">
        {session?.user.avatarUrl ? (
          <img src={session.user.avatarUrl} alt="" referrerPolicy="no-referrer" className="h-8 w-8 rounded-full object-cover" />
        ) : (
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-[13px] font-medium text-on-primary">{initial}</span>
        )}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{name}</span>
        <svg className="h-3.5 w-3.5 text-muted-soft" viewBox="0 0 24 24" fill="none">
          <path d="M6 15l6-6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}
