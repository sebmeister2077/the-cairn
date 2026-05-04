


export type ArrayKeys<Arr extends any[] | readonly any[]> = Exclude<keyof Arr, keyof any[]>;