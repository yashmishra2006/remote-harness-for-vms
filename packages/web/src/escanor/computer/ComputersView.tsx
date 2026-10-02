import { Laptop, Plus } from '@phosphor-icons/react';
import { useState } from 'react';
import { Button, ScreenHeader } from '../ui';
import ComputerDetail from './ComputerDetail';
import PairSheet from './PairSheet';
import { loadComputers, removeComputer, saveComputer } from './storage';
import type { PairedComputer } from './lib/client';

/** Your own computers running Escanor Desktop: pair one, then watch and control it from here. */
export default function ComputersView() {
  const [computers, setComputers] = useState<PairedComputer[]>(loadComputers);
  const [openId, setOpenId] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const open = computers.find((c) => c.id === openId);

  if (open) return <ComputerDetail computer={open} onBack={() => setOpenId(null)} onRemove={() => (setComputers(removeComputer(open.id)), setOpenId(null))} />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScreenHeader title="Computers"><Button onClick={() => setPairing(true)}><Plus size={16} weight="bold" /> Add</Button></ScreenHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
        {computers.length === 0 ? (
          <div className="mx-auto max-w-sm py-14 text-center">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-hairline bg-surface-card text-muted"><Laptop size={26} /></span>
            <h2 className="mt-5 text-lg font-semibold text-ink">Your computer, from your phone</h2>
            <p className="mt-2 text-sm text-body">Install Escanor Desktop on your computer and pair it here. Everything runs on that computer’s own hardware, so there is nothing extra to pay for. You just see the results and approve what matters.</p>
            <div className="mt-6"><Button onClick={() => setPairing(true)}>Add your computer</Button></div>
          </div>
        ) : (
          <ul className="space-y-2 pt-2">
            {computers.map((c) => (
              <li key={c.id}>
                <button onClick={() => setOpenId(c.id)} className="flex w-full items-center gap-3 rounded-lg border border-hairline bg-surface-card p-4 text-left transition hover:border-primary/40">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-canvas text-muted"><Laptop size={22} /></span>
                  <span className="min-w-0"><span className="block truncate text-[15px] font-medium text-ink">{c.name}</span><span className="block text-[12px] text-muted">Paired {new Date(c.pairedAt).toLocaleDateString()}{c.agentId ? ' · works away from home' : ' · on your Wi-Fi'}</span></span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {pairing && <PairSheet onClose={() => setPairing(false)} onPaired={(c) => (setComputers(saveComputer(c)), setPairing(false), setOpenId(c.id))} />}
    </div>
  );
}
