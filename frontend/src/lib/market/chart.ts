/** Trailing moving average over the last `window` samples. */
export function trailingAverage(values: number[], window: number): number[] {
    const out: number[] = [];
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
        sum += values[i];
        if (i >= window) sum -= values[i - window];
        out.push(sum / Math.min(i + 1, window));
    }
    return out;
}

/** Triangular (double-pass) moving average: a plain trailing average still steps
 * sharply as a single outlier enters and later drops out of the window, leaving
 * visible spikes. Averaging the averaged series over the same `window` softens
 * those step edges — smoothing out single-sale noise without widening the span. */
export function movingAverage(values: number[], window: number): number[] {
    return trailingAverage(trailingAverage(values, window), window);
}