import { chiselColor } from "@/components/market/chiselColors";
import {
  type ListingColumn,
  ListingNotesCell,
  ListingAttributesCell,
  formatListingDate,
  DeliveryFeeCell,
  DurationCell,
  CancelledCell,
} from "@/components/market/VirtualTable";
import { formatGameDate } from "@/lib/formatting/format-duration";
import {
  titleCase,
  liquidContainerLabel,
  liquidContainerShort,
  listingMetalType,
  listingLining,
  formatRealTimeToSell,
  deriveListingStatus,
  type AnimalGroup,
  type CombineGroup,
  type OreGroup,
} from "@/lib/market/auction";
import type { ChiselDesign } from "@/models/auction";
import { useMemo } from "react";
import { Link } from "react-router-dom";

type Deps = [
  hasVariants: boolean,
  doesCombineOres: boolean,
  oreGroup: OreGroup | null,
  isCombineActive: boolean,
  combineGroup: CombineGroup | null,
  hasChiselVariants: boolean,
  isLiquid: boolean,
  hasTextListings: boolean,
  hasToolAttrs: boolean,
  hasMetalAttr: boolean,
  hasLiningAttr: boolean,
  animalGroup: AnimalGroup | null,
  currentGameHours: number,
  realDateForGameHours: (gameHours: number | null | undefined) => string | null,
];
export function useMarketItemColumns(deps: Deps) {
  const [
    hasVariants,
    doesCombineOres,
    oreGroup,
    isCombineActive,
    combineGroup,
    hasChiselVariants,
    isLiquid,
    hasTextListings,
    hasToolAttrs,
    hasMetalAttr,
    hasLiningAttr,
    animalGroup,
    currentGameHours,
    realDateForGameHours,
  ] = deps;

  return useMemo<ListingColumn[]>(
    () => [
      ...(hasVariants
        ? [
            {
              key: "variant",
              header: "Variant",
              width: "minmax(9rem,1fr)",
              cell: (l) => (
                <span
                  className="text-xs font-medium"
                  title={`In-game variant (${l.variant ?? "—"})`}
                >
                  {l.variant ?? "—"}
                </span>
              ),
            } satisfies ListingColumn,
          ]
        : []),
      ...(doesCombineOres && oreGroup
        ? [
            {
              key: "hostRock",
              header: "Host rock",
              width: "minmax(6rem,1fr)",
              cell: (l) => (
                <span
                  className="text-xs font-medium capitalize"
                  title="Rock stratum this ore was found in"
                >
                  {oreGroup.rockByItemId.get(l.itemId) ?? "—"}
                </span>
              ),
            } satisfies ListingColumn,
          ]
        : []),
      ...(animalGroup && animalGroup.breeds.length > 0
        ? [
            {
              key: "animalBreed",
              header: "Breed",
              width: "minmax(6rem,1fr)",
              cell: (l) => (
                <span className="text-xs font-medium capitalize" title="Breed of the caught animal">
                  {l.animal?.breed ? titleCase(l.animal.breed) : "—"}
                </span>
              ),
            } satisfies ListingColumn,
          ]
        : []),
      ...(animalGroup && animalGroup.sexes.length > 0
        ? [
            {
              key: "animalSex",
              header: "Sex",
              width: "minmax(4rem,0.6fr)",
              cell: (l) => (
                <span className="text-xs capitalize" title="Sex of the caught animal">
                  {l.animal?.sex
                    ? l.animal.sex === "male"
                      ? "Male ♂"
                      : l.animal.sex === "female"
                        ? "Female ♀"
                        : titleCase(l.animal.sex)
                    : "—"}
                </span>
              ),
            } satisfies ListingColumn,
          ]
        : []),
      ...(animalGroup && animalGroup.ages.length > 0
        ? [
            {
              key: "animalAge",
              header: "Age",
              width: "minmax(4rem,0.6fr)",
              cell: (l) => (
                <span className="text-xs capitalize" title="Life stage of the caught animal">
                  {l.animal?.age ? titleCase(l.animal.age) : "—"}
                </span>
              ),
            } satisfies ListingColumn,
          ]
        : []),
      ...(isCombineActive && combineGroup
        ? [
            {
              key: "combineType",
              header: "Type",
              width: "minmax(6rem,1fr)",
              cell: (l) => (
                <span
                  className="text-xs font-medium"
                  title="Which form of this item this listing is"
                >
                  {combineGroup.typeByItemId.get(l.itemId) ?? "—"}
                </span>
              ),
            } satisfies ListingColumn,
          ]
        : []),
      ...(hasChiselVariants
        ? [
            {
              key: "design",
              header: "Design",
              width: "minmax(6rem,1fr)",
              cell: (l) => <ChiselSwatches design={l.chisel} />,
            } satisfies ListingColumn,
          ]
        : []),
      ...(isLiquid
        ? [
            {
              key: "container",
              header: "Container",
              width: "minmax(5.5rem,0.9fr)",
              cell: (l) =>
                l.liquid ? (
                  <span
                    className="text-xs capitalize"
                    title={`Sold ${liquidContainerLabel(l.liquid.container)}`}
                  >
                    {liquidContainerShort(l.liquid.container)}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                ),
            } satisfies ListingColumn,
          ]
        : []),
      ...(hasTextListings
        ? [
            {
              key: "notes",
              header: "Notes",
              width: "minmax(4.5rem,0.8fr)",
              cell: (l) => <ListingNotesCell listing={l} />,
            } satisfies ListingColumn,
          ]
        : []),
      ...(hasMetalAttr
        ? [
            {
              key: "metal",
              header: "Metal",
              width: "minmax(5rem,0.9fr)",
              cell: (l) => {
                const metal = listingMetalType(l);
                return metal ? (
                  <span className="text-xs" title="Metal this lantern's frame is cast from">
                    {metal}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                );
              },
            } satisfies ListingColumn,
          ]
        : []),
      ...(hasLiningAttr
        ? [
            {
              key: "lining",
              header: "Lining",
              width: "minmax(4.5rem,0.7fr)",
              cell: (l) => {
                const lining = listingLining(l);
                return lining ? (
                  <span className="text-xs" title={`Lining: ${lining}`}>
                    {lining}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground" title="No lining">
                    —
                  </span>
                );
              },
            } satisfies ListingColumn,
          ]
        : []),
      ...(hasToolAttrs
        ? [
            {
              key: "attrs",
              header: "Details",
              width: "minmax(5rem,0.8fr)",
              cell: (l) => <ListingAttributesCell listing={l} />,
            } satisfies ListingColumn,
          ]
        : []),
      {
        key: "date",
        header: "Game date",
        width: "6.5rem",
        cell: (l) => (
          <span
            className="text-xs text-muted-foreground"
            title={`Observed ${formatListingDate(l.observedUtc ?? l.lastObservedUtc)}`}
          >
            {formatGameDate(l.postedTotalHours)}
          </span>
        ),
      },
      {
        key: "realDate",
        header: "Real date",
        width: "6rem",
        cell: (l) => (
          <span
            className="text-xs text-muted-foreground"
            title="Real-world date this listing was posted (derived from its in-game posting time)"
          >
            {formatListingDate(realDateForGameHours(l.postedTotalHours))}
          </span>
        ),
      },
      {
        key: "price",
        header: "Price",
        width: "6rem",
        align: "right",
        cell: (l) => l.price.toLocaleString(),
      },
      {
        key: "qty",
        header: isLiquid ? "Litres" : "Qty",
        width: "3.5rem",
        align: "right",
        cell: (l) => (isLiquid && l.liquid ? `${l.qty.toLocaleString()} L` : `×${l.qty}`),
      },
      {
        key: "seller",
        header: "Seller",
        width: "minmax(6rem,1fr)",
        cell: (l) =>
          l.sellerUid ? (
            <Link
              to={`/market/players/${encodeURIComponent(l.sellerUid)}`}
              className="text-xs hover:underline"
            >
              {l.sellerName ?? "—"}
            </Link>
          ) : (
            <span className="text-xs text-muted-foreground">{l.sellerName ?? "—"}</span>
          ),
      },
      {
        key: "buyer",
        header: "Buyer",
        width: "minmax(6rem,1fr)",
        cell: (l) =>
          l.sold && l.buyerUid ? (
            <Link
              to={`/market/players/${encodeURIComponent(l.buyerUid)}`}
              className="text-xs hover:underline"
            >
              {l.buyerName ?? "—"}
            </Link>
          ) : (
            <span className="text-xs text-muted-foreground">
              {l.sold ? (l.buyerName ?? "—") : "—"}
            </span>
          ),
      },
      {
        key: "timeToSell",
        header: "Sold in",
        width: "minmax(5.5rem,0.9fr)",
        align: "right",
        cell: (l) => (
          <span
            className="text-xs text-muted-foreground"
            title="Real-world time from posting to sale"
          >
            {l.sold && l.timeToSellHours != null ? formatRealTimeToSell(l.timeToSellHours) : "—"}
          </span>
        ),
      },
      {
        key: "delivery",
        header: "Delivery",
        width: "minmax(4.5rem,0.7fr)",
        align: "right",
        cell: (l) => <DeliveryFeeCell listing={l} />,
      },
      {
        key: "duration",
        header: "Duration",
        width: "minmax(4.5rem,0.6fr)",
        align: "right",
        cell: (l) => <DurationCell listing={l} />,
      },
      {
        key: "status",
        header: "Status",
        width: "5rem",
        cell: (l) => {
          // A cancelled listing carries the amber "Cancelled" badge; otherwise
          // the shared status derivation so this matches the player-profile
          // table: a last-seen-Active listing that dropped out of the latest
          // sweep (or whose duration elapsed) reads "untracked", not "active?".
          if (l.cancelled) return <CancelledCell listing={l} />;
          const status = deriveListingStatus(l, currentGameHours);
          const unconfirmed = status === "unconfirmed";
          const untracked = status === "removed";
          return (
            <span
              className="text-xs text-muted-foreground"
              title={
                unconfirmed
                  ? "Final outcome never recorded — last observed state, not a confirmed live listing"
                  : untracked
                    ? "Its final outcome (sold or expired) was never recorded in time — the listing left the Auction House before we could capture the result"
                    : undefined
              }
            >
              {unconfirmed ? "active?" : untracked ? "untracked" : status}
            </span>
          );
        },
      },
    ],
    [
      hasVariants,
      doesCombineOres,
      oreGroup,
      isCombineActive,
      combineGroup,
      hasChiselVariants,
      isLiquid,
      hasTextListings,
      hasToolAttrs,
      hasMetalAttr,
      hasLiningAttr,
      animalGroup,
      currentGameHours,
      realDateForGameHours,
    ],
  );
}

/** Compact, WebGL-free preview of a listing's design: one colour chip per
 * material plus the box count, so rows in a mixed group are distinguishable. */
function ChiselSwatches({ design }: { design: ChiselDesign | null | undefined }) {
  if (!design) return <span className="text-xs text-muted-foreground">—</span>;
  const codes = Array.from(new Set(design.materials));
  return (
    <span className="inline-flex items-center gap-1" title={codes.join(", ")}>
      {codes.slice(0, 6).map((code, i) => (
        <span
          key={i}
          className="inline-block size-3 rounded-sm border"
          style={{ background: chiselColor(code) }}
        />
      ))}
      <span className="ml-1 text-xs text-muted-foreground">{design.boxes.length}p</span>
    </span>
  );
}
