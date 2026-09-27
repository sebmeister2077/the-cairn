import { useMemo } from "react";
import { PawPrint } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  titleCase,
  type AnimalGroup,
  type AnimalSelection,
  animalListingMatches,
} from "@/lib/auction";
import type { AnimalInfo } from "@/models/auction";

/** A minimal view of the item-images hook (see `useItemImages`). */
interface ImageResolver {
  creatureImage(code: string | null | undefined): string | null;
}

interface AnimalSelectionCardProps {
  group: AnimalGroup;
  selection: AnimalSelection;
  onChange: (next: AnimalSelection) => void;
  /** Every animal listing for this species (unfiltered by the selection), for
   *  per-option counts and the total. */
  listings: { animal?: AnimalInfo | null }[];
  images: ImageResolver;
}

/** Toggle a value in an immutable set-backed facet. */
function toggle(set: Set<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

const SEX_LABEL: Record<string, string> = { male: "Male ♂", female: "Female ♀" };

export function AnimalSelectionCard({
  group,
  selection,
  onChange,
  listings,
  images,
}: AnimalSelectionCardProps) {
  // How many listings each facet option covers (within the other active
  // filters), so a user can see which selections actually have data.
  const counts = useMemo(() => {
    const breed = new Map<string, number>();
    const age = new Map<string, number>();
    const sex = new Map<string, number>();
    const bump = (m: Map<string, number>, k: string | null) => {
      if (k) m.set(k, (m.get(k) ?? 0) + 1);
    };
    for (const l of listings) {
      const a = l.animal;
      if (!a) continue;
      bump(breed, a.breed);
      bump(age, a.age);
      bump(sex, a.sex);
    }
    return { breed, age, sex };
  }, [listings]);

  const matchCount = useMemo(
    () => listings.filter((l) => animalListingMatches(l.animal, selection)).length,
    [listings, selection],
  );

  // Which breeds to preview: the selected ones, or a single species-level image
  // when nothing is picked (avoids flooding the card with every breed at once).
  const previewBreeds = selection.breeds.size
    ? group.breeds.filter((b) => selection.breeds.has(b))
    : [null];
  const previews = previewBreeds.map((breed) => {
    const parts = [group.species];
    if (breed) parts.push(breed);
    // Pin age/sex into the code only when exactly one is chosen, so the render
    // matches the narrowed selection; otherwise fall back to a representative.
    if (selection.ages.size === 1) parts.push([...selection.ages][0]);
    if (selection.sexes.size === 1) parts.push([...selection.sexes][0]);
    const code = parts.join("-");
    return {
      key: breed ?? group.species,
      label: breed ? `${titleCase(breed)} ${group.species}` : group.name,
      url: images.creatureImage(code),
    };
  });

  const facet = (
    title: string,
    key: "breeds" | "ages" | "sexes",
    options: string[],
    countMap: Map<string, number>,
    label?: (v: string) => string,
  ) => {
    if (options.length === 0) return null;
    const active = selection[key];
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="w-14 shrink-0 text-sm text-muted-foreground">{title}</span>
        <Button
          size="sm"
          variant={active.size === 0 ? "default" : "outline"}
          className="h-7"
          onClick={() => onChange({ ...selection, [key]: new Set<string>() })}
        >
          All
        </Button>
        {options.map((opt) => (
          <Button
            key={opt}
            size="sm"
            variant={active.has(opt) ? "default" : "outline"}
            className="h-7 capitalize"
            onClick={() => onChange({ ...selection, [key]: toggle(active, opt) })}
          >
            {label ? label(opt) : titleCase(opt)}
            <span className="ml-1 text-xs opacity-60">{countMap.get(opt) ?? 0}</span>
          </Button>
        ))}
      </div>
    );
  };

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex items-baseline gap-2">
          <h2 className="font-semibold">Animal selection</h2>
          <span className="text-xs text-muted-foreground">
            {matchCount.toLocaleString()} of {listings.length.toLocaleString()} listings
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          Narrow the price figures to a specific breed, life stage or sex. Every figure on this page
          reflects the current selection.
        </p>

        <div className="flex flex-wrap items-start gap-4">
          <div className="flex min-w-[16rem] flex-1 flex-col gap-2">
            {facet("Breed", "breeds", group.breeds, counts.breed)}
            {facet("Sex", "sexes", group.sexes, counts.sex, (v) => SEX_LABEL[v] ?? titleCase(v))}
            {facet("Age", "ages", group.ages, counts.age)}
          </div>

          <div className="flex flex-wrap gap-3">
            {previews.map((p) => (
              <figure key={p.key} className="w-28 text-center">
                {p.url ? (
                  <img
                    src={p.url}
                    alt={p.label}
                    className="mx-auto size-24 rounded-md border bg-muted/30 object-contain p-1"
                    loading="lazy"
                  />
                ) : (
                  <div
                    className="mx-auto flex size-24 flex-col items-center justify-center gap-1 rounded-md border border-dashed bg-muted/20 text-muted-foreground"
                    title="No render available yet"
                  >
                    <PawPrint className="size-6 opacity-50" aria-hidden />
                  </div>
                )}
                <figcaption className="mt-1 text-xs capitalize text-muted-foreground">
                  {p.label}
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
