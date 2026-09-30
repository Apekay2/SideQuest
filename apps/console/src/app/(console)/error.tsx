'use client';

export default function ConsoleError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <>
      <h1>Something went wrong</h1>
      <p className="lede">The console could not load this view. {error.digest ? `Reference ${error.digest}.` : ''}</p>
      <button className="btn outline" onClick={reset}>Try again</button>
    </>
  );
}
