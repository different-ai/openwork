import { CloudControlPanel } from "../components/cloud-control";

export default function HomePage() {
  return (
    <main className="ow-shell">
      <div className="ow-ambient" aria-hidden>
        <span className="ow-blob ow-blob-one" />
        <span className="ow-blob ow-blob-two" />
        <span className="ow-blob ow-blob-three" />
      </div>

      <header className="ow-brand">
        <span className="ow-brand-icon" aria-hidden>
          <span className="ow-brand-icon-core" />
        </span>
        <span className="ow-brand-text">OpenWork</span>
      </header>

      <CloudControlPanel />

      <p className="ow-footer">Secured by OpenWork Software. Proxied to api.openwork.software.</p>
    </main>
  );
}
