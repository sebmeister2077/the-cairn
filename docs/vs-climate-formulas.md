# Vintage Story climate formulas (temperature & precipitation vs. altitude)

Source: decompiled `Vintagestory.API.Common.Climate` (`VintagestoryAPI.dll`, VS 1.22) plus the
callers in `ServerWorldMap.getWorldGenClimateAt` / `ClientWorldMap.GetClimateAt`.

All climate map values are stored packed in a 24-bit int per world column:

```
climate = (temperature << 16) | (rainfall << 8) | geologicActivity
temperatureByte    = (climate >> 16) & 0xFF   // 0..255, "unscaled" temperature
rainfallByte       = (climate >>  8) & 0xFF   // 0..255, base rainfall
geologicActivity   =  climate        & 0xFF   // 0..255
```

Those bytes are the **sea-level baseline**. The functions below adjust them for the actual world
height `y` and convert to real-world units.

---

## Constants

| Name | Value | Notes |
| --- | --- | --- |
| `Sealevel` | `110` | Default; set from world config on load. Use the world's actual sea level if known. |
| `TemperatureScaleConversion` | `4.25` | Maps real °C range to the 0..255 byte range. |

`distToSealevel = y - Sealevel` (positive above sea level, negative below).

---

## Temperature

### Real temperature at height `y` (server / gameplay values)

```
temperature(y) = clamp( (temperatureByte - distToSealevel / 1.5) / 4.25 - 20 , -20 , 40 )
```

- Output is in **°C**, clamped to `[-20, 40]`.
- The client-side variant (`GetScaledAdjustedTemperatureFloatClient`) is identical but clamps the
  lower bound to `-50` instead of `-20`:

```
temperatureClient(y) = clamp( (temperatureByte - distToSealevel / 1.5) / 4.25 - 20 , -50 , 40 )
```

### Sea-level temperature (the baseline)

At `y = Sealevel`, `distToSealevel = 0`, so:

```
temperatureAtSeaLevel = clamp( temperatureByte / 4.25 - 20 , -20 , 40 )
```

### Lapse rate — how temperature changes with altitude

Before clamping, temperature is linear in height:

```
temperature(y) = temperatureAtSeaLevel - (y - Sealevel) / (1.5 * 4.25)
               = temperatureAtSeaLevel - (y - Sealevel) / 6.375
```

So real temperature drops by **1 / 6.375 ≈ 0.1569 °C per block** of elevation above sea level, and
rises by the same amount per block below sea level (until it hits the clamp).

> The `/1.5` divisor is also hard-coded in the game's `shaderincludes/colormap.vsh`.

---

## Precipitation / rainfall

`rainfallByte` (0..255) is the sea-level baseline. Adjusted for height with **integer math**:

```
rainfall(y) = clamp(
    rainfallByte
  + (y - Sealevel) / 2                       // integer division
  + 5 * clamp(8 + Sealevel - y, 0, 8),
    0, 255
)
```

Normalized to `[0, 1]` (as exposed in `ClimateCondition.Rainfall` / `WorldgenRainfall`):

```
rainfallNormalized(y) = rainfall(y) / 255
```

Breakdown of the height terms:

1. `+ (y - Sealevel) / 2` — rainfall increases with altitude, about **+0.5 byte per block** up
   (and decreases below sea level). Integer division truncates toward zero.
2. `+ 5 * clamp(8 + Sealevel - y, 0, 8)` — a near/below-sea-level humidity bonus:
   - `y <= Sealevel`: full **+40** (the clamp caps the term at 8, times 5).
   - `Sealevel < y < Sealevel + 8`: ramps down by **5 per block**.
   - `y >= Sealevel + 8`: **0**.

---

## Fertility (bonus, derived from rainfall + temperature)

```
descaledTemp = clamp( (temperatureReal + 20) * 4.25 , 0 , 255 )   // real °C -> byte
posYRel      = (y - Sealevel) / (mapSizeY - Sealevel)

f1 = min(255, rainfallByte / 2 + max(0, rainfallByte * descaledTemp / 512))
f2 = 1 - max(0, (80 - f1) / 80)
fertility = max(0, f1 - max(0, 50 * (posYRel - 0.5)) * f2)     // byte 0..255
fertilityNormalized = fertility / 255
```

(`GetFertilityFromUnscaledTemp` uses the raw `temperatureByte` directly in place of `descaledTemp`.)

---

## Reverse conversions

Real °C back to the stored byte:

```
DescaleTemperature(tempReal) = clamp( (tempReal + 20) * 4.25 , 0 , 255 )
```

- `-20 °C -> 0`, `+40 °C -> 255`.

---

## Reference implementation (JavaScript / TypeScript)

```ts
const SEALEVEL = 110;                 // use the world's real sea level if you have it
const TEMP_SCALE = 4.25;

/** Real temperature in °C at world height y. */
export function temperatureAt(temperatureByte: number, y: number, clientRange = false): number {
  const distToSealevel = y - SEALEVEL;
  const t = (temperatureByte - distToSealevel / 1.5) / TEMP_SCALE - 20;
  return clamp(t, clientRange ? -50 : -20, 40);
}

/** Sea-level baseline temperature in °C. */
export function temperatureAtSeaLevel(temperatureByte: number): number {
  return clamp(temperatureByte / TEMP_SCALE - 20, -20, 40);
}

/** Rainfall byte (0..255) at world height y. Divide by 255 for a 0..1 value. */
export function rainfallAt(rainfallByte: number, y: number): number {
  const alt = Math.trunc((y - SEALEVEL) / 2);           // C# integer division
  const bonus = 5 * clamp(8 + SEALEVEL - y, 0, 8);
  return clamp(rainfallByte + alt + bonus, 0, 255);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
```
