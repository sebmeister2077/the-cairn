// Small item/block thumbnail for the market tables. `url` is resolved by the
// page from `useItemImages()`; a null url renders an equal-size spacer so item
// names stay aligned whether or not an icon exists.

export function ItemThumb({
  url,
  alt,
  className = "size-7",
}: {
  url: string | null;
  alt: string;
  className?: string;
}) {
  if (!url) return <span className={`${className} shrink-0`} aria-hidden />;
  return (
    <img
      src={url}
      alt={alt}
      loading="lazy"
      className={`${className} shrink-0 rounded border bg-muted/30 object-contain p-0.5`}
    />
  );
}
