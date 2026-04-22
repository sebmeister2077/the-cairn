/** Format an ISO date string or null to locale string */
export function fmt(iso: string | null): string {
    if (!iso) return "—";
    return new Date(iso).toLocaleString();
}
