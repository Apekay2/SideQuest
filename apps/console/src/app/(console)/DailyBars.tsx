'use client';

import { useState } from 'react';

export interface Day { day: string; value: number }

// One series, so no legend: the heading names it. Bars are <= 24px with a rounded data end and
// a square baseline; each is focusable and shows its value in a readout drawn inside the SVG
// (the CSP allows no inline styles, so nothing is positioned with CSS). The table below the
// chart carries every value for anyone not using a pointer.
export function DailyBars({ days, label, format = String }: { days: Day[]; label: string; format?: (n: number) => string }) {
  const [active, setActive] = useState<number | null>(null);
  // Drawn at roughly its rendered width, so text in the SVG stays at true size.
  const W = 1080, H = 200, PAD_L = 8, PAD_B = 22, PAD_T = 26;
  const max = Math.max(1, ...days.map((d) => d.value));
  const band = (W - PAD_L * 2) / days.length;
  const bw = Math.min(24, band - 6);
  const y = (v: number) => PAD_T + (H - PAD_T - PAD_B) * (1 - v / max);
  const bar = (i: number, v: number) => {
    const x = PAD_L + band * i + (band - bw) / 2, top = y(v), base = H - PAD_B, r = Math.min(4, (base - top) / 2);
    if (v === 0) return '';
    return `M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${base} Z`;
  };
  const short = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Africa/Nairobi' });
  const peak = days.reduce((m, d, i) => (d.value > days[m]!.value ? i : m), 0);

  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label}, last ${days.length} days`} className="chart-svg">
        <line x1={PAD_L} x2={W - PAD_L} y1={H - PAD_B} y2={H - PAD_B} className="chart-axis" />
        {days.map((d, i) => {
          const x = PAD_L + band * i;
          return (
            <g key={d.day} tabIndex={0} role="button" aria-label={`${short(d.day)}: ${format(d.value)}`}
               onPointerEnter={() => setActive(i)} onPointerLeave={() => setActive(null)}
               onFocus={() => setActive(i)} onBlur={() => setActive(null)} className="chart-hit">
              {/* The hit target is the whole band, bigger than the mark. */}
              <rect x={x} y={PAD_T - 4} width={band} height={H - PAD_T - PAD_B + 4} className="chart-band" />
              <path d={bar(i, d.value)} className={`chart-bar${active === i ? ' on' : ''}`} />
              {(i === 0 || i === days.length - 1 || i % 7 === 0) && (
                <text x={x + band / 2} y={H - 6} textAnchor="middle" className="chart-tick">{short(d.day)}</text>
              )}
            </g>
          );
        })}
        {/* Selective direct label: the peak only, at its cap. */}
        {days[peak]!.value > 0 && active === null && (
          <text x={PAD_L + band * peak + band / 2} y={y(days[peak]!.value) - 6} textAnchor="middle" className="chart-value">
            {format(days[peak]!.value)}
          </text>
        )}
        {active !== null && (() => {
          const d = days[active]!, cx = PAD_L + band * active + band / 2;
          const tx = Math.min(Math.max(cx - 58, 2), W - 118);
          return (
            <g className="chart-tip" pointerEvents="none">
              <rect x={tx} y={2} width={116} height={20} rx={10} />
              <text x={tx + 58} y={16} textAnchor="middle"><tspan className="strong">{format(d.value)}</tspan>{` · ${short(d.day)}`}</text>
            </g>
          );
        })()}
      </svg>
      <details className="chart-table">
        <summary>Show as a table</summary>
        <table className="table compact">
          <thead><tr><th scope="col">Day</th><th scope="col" className="num">{label}</th></tr></thead>
          <tbody>{days.map((d) => <tr key={d.day}><td>{short(d.day)}</td><td className="num">{format(d.value)}</td></tr>)}</tbody>
        </table>
      </details>
    </figure>
  );
}
