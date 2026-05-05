import type { ArrayKeys } from "@/models/UtilityTypes";

declare global {
    interface Array<T> {
        last(): T | undefined;
        max(): T extends number ? number : never;
        sortBy<Keys extends Array<T extends any[] ? ArrayKeys<T> : keyof T>>(keys: Keys, ascending?: boolean): T[];
    }
}

export function setPrototypes() {
    const newPrototype = {
        ...Array.prototype,
        last(): any {
            return this.slice(-1)[0];
        },
        max(): any {
            return Math.max(...this);
        },
        sortBy<T extends object, Keys extends Array<T extends any[] ? ArrayKeys<T> : keyof T>>(keys: Keys, ascending = true) {
            return this.slice().sort((item1: T, item2: T) => {
                const reversedKeys = [...keys].reverse() as Keys;
                let key = reversedKeys.pop();
                const firstCond = ascending ? 1 : -1;
                const secondCond = ascending ? -1 : 1;


                while (key) {
                    const areBothNumbers = typeof item1[key] === "number" && typeof item2[key] === "number";
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
        }

    }
    Object.setPrototypeOf(Array.prototype, newPrototype
    );
}