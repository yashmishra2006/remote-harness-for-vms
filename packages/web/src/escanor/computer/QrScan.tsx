import { useEffect, useRef, useState } from 'react';
import { Notice } from '../ui';

/** Scans a QR code with the camera using the platform's BarcodeDetector. Where that is missing, the caller shows manual entry. */
export default function QrScan({ onCode, onUnavailable }: { onCode: (text: string) => void; onUnavailable: (why: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [starting, setStarting] = useState(true);

  useEffect(() => {
    let stop = false;
    let stream: MediaStream | null = null;
    (async () => {
      const Detector = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => { detect: (v: HTMLVideoElement) => Promise<Array<{ rawValue: string }>> } }).BarcodeDetector;
      if (!Detector || !navigator.mediaDevices?.getUserMedia) return onUnavailable('This phone cannot scan codes here.');
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      } catch {
        return onUnavailable('Camera access was not allowed.');
      }
      if (stop || !video.current) return;
      video.current.srcObject = stream;
      await video.current.play().catch(() => undefined);
      setStarting(false);
      const detector = new Detector({ formats: ['qr_code'] });
      const tick = async () => {
        if (stop || !video.current) return;
        try {
          const found = await detector.detect(video.current);
          if (found[0]?.rawValue) return onCode(found[0].rawValue);
        } catch {
          // a frame that cannot be read is skipped
        }
        setTimeout(tick, 250);
      };
      void tick();
    })();
    return () => {
      stop = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onCode, onUnavailable]);

  return (
    <div className="overflow-hidden rounded-lg border border-hairline bg-black">
      <video ref={video} playsInline muted className="aspect-square w-full object-cover" />
      {starting && <div className="p-3"><Notice>Starting the camera…</Notice></div>}
    </div>
  );
}
