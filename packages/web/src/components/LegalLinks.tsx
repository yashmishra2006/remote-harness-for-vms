/** Escanor service notices; independent hub operators must supply their own notices. */
export default function LegalLinks() {
  return (
    <div className="mt-4 text-xs leading-relaxed text-muted">
      <nav aria-label="Legal and support" className="flex flex-wrap gap-x-3 gap-y-1">
        <a href="https://www.escanor.in/privacy" target="_blank" rel="noopener noreferrer" className="underline">Escanor privacy</a>
        <a href="https://www.escanor.in/terms" target="_blank" rel="noopener noreferrer" className="underline">Terms</a>
        <a href="https://www.escanor.in/support" target="_blank" rel="noopener noreferrer" className="underline">Support</a>
      </nav>
      <p className="mt-2">For a self-hosted hub, ask its operator about access, storage and deletion of your session data.</p>
    </div>
  );
}
