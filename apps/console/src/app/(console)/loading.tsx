// Shown while a queue or case loads: the page's own shape, so nothing jumps when data lands.
export default function Loading() {
  return (
    <div role="status" aria-live="polite" className="loading">
      <span className="visually-hidden">Loading…</span>
      <div className="skel skel-title" />
      <div className="skel skel-line" />
      <div className="skel skel-block" />
    </div>
  );
}
