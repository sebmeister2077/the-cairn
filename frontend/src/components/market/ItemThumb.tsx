// Small item/block thumbnail for the market tables. `url` is resolved by the
// page from `useItemImages()`; a null url renders an equal-size spacer so item
// names stay aligned whether or not an icon exists. It's always shown next to
// the item's name, so the image is decorative (empty alt).

export function ItemThumb({
  url,
  className = "size-7",
}: {
  url: string | null;
  className?: string;
}) {
  if (!url) return <span className={`${className} shrink-0`} aria-hidden />;
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      className={`${className} shrink-0 rounded border bg-muted/30 object-contain p-0.5`}
    />
  );
}
