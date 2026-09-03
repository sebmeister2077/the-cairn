export function FreshnessBanner({ generatedUtc }: { generatedUtc: string }) {
  const when = new Date(generatedUtc);
  const rel = (() => {
    const mins = Math.round((Date.now() - when.getTime()) / 60000);
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 48) return `${hrs} h ago`;
    return `${Math.round(hrs / 24)} days ago`;
  })();
  return (
    <p className="text-xs text-muted-foreground">
      Market snapshot last updated {when.toLocaleString()} ({rel}). Data is captured periodically
      from the in-game Auction House.
    </p>
  );
}
