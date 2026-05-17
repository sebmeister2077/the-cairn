import { Home, Pin, PinOff } from "lucide-react";
import { Button } from "../ui/button";

type HomePositionControlsProps = {
  favorite: { x: number; z: number; zoom?: number } | null;
  /** Set when the map has reported at least one viewport, enabling "save". */
  canSaveCurrent: boolean;
  onJumpHome: () => void;
  onSaveCurrent: () => void;
  onClear: () => void;
  /** Compact variant for the fullscreen overlay (icon-only buttons). */
  compact?: boolean;
};

/**
 * Tri-action control for the user's "starting position":
 *   1. Jump to home (or spawn 0,0 when unset). Always enabled.
 *   2. Pin / unpin: when no favorite exists, saves the current viewport
 *      center as the favorite. When a favorite exists, clears it.
 *
 * The current favorite coordinates are surfaced via tooltips on both
 * buttons so the user can see what's saved without opening a menu.
 */
export function HomePositionControls({
  favorite,
  canSaveCurrent,
  onJumpHome,
  onSaveCurrent,
  onClear,
  compact = false,
}: HomePositionControlsProps) {
  const hasFavorite = favorite != null;
  const favoriteLabel = hasFavorite ? `(${favorite.x}, ${favorite.z})` : "spawn (0, 0)";
  const jumpTitle = hasFavorite
    ? `Jump to starting position ${favoriteLabel}`
    : "Jump to spawn (0, 0) — no starting position set";
  const pinTitle = hasFavorite
    ? `Clear starting position ${favoriteLabel}`
    : canSaveCurrent
      ? "Save current view as starting position"
      : "Pan the map first, then save it as your starting position";

  const buttonSize = compact ? "sm" : "default";
  const iconSize = compact ? "size-4" : "size-4";

  return (
    <div
      className={
        compact
          ? "pointer-events-auto inline-flex items-center gap-1 rounded-md border bg-background/95 p-0.5 shadow-md backdrop-blur"
          : "inline-flex items-center gap-1"
      }
    >
      <Button
        type="button"
        variant={compact ? "ghost" : "outline"}
        size={buttonSize}
        onClick={onJumpHome}
        title={jumpTitle}
        aria-label={jumpTitle}
      >
        <Home className={iconSize} />
        {!compact && (
          <span className="ml-1">
            {hasFavorite ? "Home" : "Spawn"}
            {hasFavorite && (
              <span className="ml-1 text-xs text-muted-foreground">{favoriteLabel}</span>
            )}
          </span>
        )}
      </Button>
      <Button
        type="button"
        variant={compact ? "ghost" : "outline"}
        size={buttonSize}
        onClick={hasFavorite ? onClear : onSaveCurrent}
        disabled={!hasFavorite && !canSaveCurrent}
        title={pinTitle}
        aria-label={pinTitle}
      >
        {hasFavorite ? <PinOff className={iconSize} /> : <Pin className={iconSize} />}
        {!compact && <span className="ml-1">{hasFavorite ? "Clear" : "Pin here"}</span>}
      </Button>
    </div>
  );
}
