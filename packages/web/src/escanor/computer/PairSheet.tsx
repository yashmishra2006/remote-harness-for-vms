import { useState } from 'react';
import { Button, Notice, Sheet, Spinner } from '../ui';
import QrScan from './QrScan';
import { pairWithPayload, type PairedComputer } from './lib/client';
import type { PairingPayload } from './lib/protocol';

function parsePayload(text: string): PairingPayload | null {
  try {
    const v = JSON.parse(text);
    return v && v.v === 1 && typeof v.code === 'string' && Array.isArray(v.lan) ? (v as PairingPayload) : null;
  } catch {
    return null;
  }
}

/** Pair with a computer: scan the QR code on its Phone screen, or type the code and address shown beside it. */
export default function PairSheet({ onPaired, onClose }: { onPaired: (c: PairedComputer) => void; onClose: () => void }) {
  const [manual, setManual] = useState(false);
  const [why, setWhy] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const deviceName = /Android/i.test(navigator.userAgent) ? 'Android phone' : /iPhone|iPad/i.test(navigator.userAgent) ? 'iPhone' : 'Phone';

  const pair = async (payload: PairingPayload) => {
    setBusy(true);
    setError(null);
    try {
      onPaired(await pairWithPayload(payload, deviceName));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Pairing did not work.');
      setBusy(false);
    }
  };

  return (
    <Sheet title="Add your computer" onClose={onClose}>
      <p className="text-sm text-body">On your computer, open Escanor Desktop, go to <b>Phone</b>, and choose <b>Pair a phone</b>. Then scan the code it shows.</p>
      <div className="mt-4 space-y-3">
        {error && <Notice tone="error">{error}</Notice>}
        {busy ? (
          <div className="flex items-center gap-3 py-6 text-sm text-muted"><Spinner /> Pairing…</div>
        ) : !manual ? (
          <>
            <QrScan
              onCode={(text) => {
                const p = parsePayload(text);
                p ? void pair(p) : setError('That is not an Escanor pairing code.');
              }}
              onUnavailable={(w) => (setWhy(w), setManual(true))}
            />
            <Button kind="quiet" onClick={() => setManual(true)}>Enter the code instead</Button>
          </>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void pair({ v: 1, code: code.trim(), machine: 'My computer', lan: address.trim() ? [address.trim()] : [], agentId: null });
            }}
          >
            {why && <Notice>{why} Type the code instead.</Notice>}
            <label className="block text-sm text-body">Pairing code
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="ABCD-EFGH-…" autoCapitalize="characters" className="mt-1 w-full rounded-md border border-hairline bg-surface-card px-3 py-2.5 font-mono text-sm text-ink outline-none focus:border-primary" />
            </label>
            <label className="block text-sm text-body">Computer address (shown under the code)
              <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="192.168.1.20:47625" inputMode="url" className="mt-1 w-full rounded-md border border-hairline bg-surface-card px-3 py-2.5 font-mono text-sm text-ink outline-none focus:border-primary" />
            </label>
            <div className="flex gap-2"><Button type="submit" disabled={!code.trim() || !address.trim()}>Pair</Button><Button kind="quiet" onClick={() => { setManual(false); setWhy(null); }}>Scan instead</Button></div>
          </form>
        )}
      </div>
    </Sheet>
  );
}
