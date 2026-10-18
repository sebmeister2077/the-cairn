import type { ArrayKeys } from "@/models/UtilityTypes";

declare global {
    interface Array<T> {
        last(): T | undefined;
        max(): T extends number ? number : never;
        sortBy<Keys extends Array<T extends any[] ? ArrayKeys<T> : keyof T>>(keys: Keys, ascending?: boolean): T[];
    }
}

// We attach helpers directly to `Array.prototype` with non-enumerable
// descriptors. Two reasons this matters:
//
//  1. Enumerable inherited props on arrays trip Redux Toolkit's
//     `serializableCheck`/`immutableCheck` middleware. It enumerates
//     `for...in` over array values it tracks, so anything visible there
//     gets snapshotted; on Vite HMR a re-run of `setPrototypes` would
//     swap the function references and Redux would (correctly!) report
//     a "state mutation" at e.g. `slice.someArray.last`.
//  2. The previous implementation called `Object.setPrototypeOf(
//     Array.prototype, newPrototype)`, which clobbers
//     `Array.prototype`'s real prototype (`Object.prototype`) with a
//     hand-rolled copy. That breaks anything that walks the prototype
//     chain (including `instanceof`, hasOwnProperty lookups, etc.).
//
// Idempotent: if a helper is already defined we leave it alone so HMR
// double-invocations don't churn descriptors.

function defineHelper(name: string, value: (...args: any[]) => any) {
    if (Object.prototype.hasOwnProperty.call(Array.prototype, name)) return;
    Object.defineProperty(Array.prototype, name, {
        value,
        writable: true,
        configurable: true,
        enumerable: false,
    });
}

export function setPrototypes() {
    defineHelper("last", function last(this: unknown[]) {
        return this[this.length - 1];
    });
    defineHelper("max", function max(this: number[]) {
        return Math.max(...this);
    });
    defineHelper("sortBy", function sortBy<
        T extends object,
        Keys extends Array<T extends any[] ? ArrayKeys<T> : keyof T>,
    >(this: T[], keys: Keys, ascending = true) {
        return this.slice().sort((item1: T, item2: T) => {
            const reversedKeys = [...keys].reverse() as Keys;
            let key = reversedKeys.pop();
            const firstCond = ascending ? 1 : -1;
            const secondCond = ascending ? -1 : 1;

            while (key) {
                const areBothNumbers =
                    typeof item1[key] === "number" && typeof item2[key] === "number";
                let secondItem: any = item2[key];
                let firstItem: any = item1[key];
                if (!areBothNumbers) {
                    secondItem = String(secondItem).toLocaleLowerCase();
                    firstItem = String(firstItem).toLocaleLowerCase();
                }

                if (firstItem > secondItem) return firstCond;
                if (firstItem < secondItem) return secondCond;
                key = reversedKeys.pop();
            }
            return 0;
        });
    });
}