'use client';

// Documents and evidence are shown, never offered: no link to the file, no drag, no context
// menu. That is friction, not protection — a screenshot still works — which is why every view
// is audited server-side as well.
export function Photo({ src, caption, missing = 'Not provided', rejected = false }:
  { src: string | null; caption: string; missing?: string; rejected?: boolean }) {
  return (
    <figure className={`photo${rejected ? ' rejected' : ''}`}>
      {src
        ? <img src={src} alt={caption} draggable={false} referrerPolicy="no-referrer" onContextMenu={(e) => e.preventDefault()} />
        : <div className="tile"><span className="v muted">{missing}</span></div>}
      <figcaption>{caption}</figcaption>
    </figure>
  );
}
