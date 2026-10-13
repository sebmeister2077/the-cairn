// In-game calendar for this server: 24 in-game hours per day, 30 days per
// month, 12 months per year. `PostedTotalHours` (carried through as
// `postedTotalHours`) is the total in-game hours since world start at the
// moment the auction was posted, so we can reconstruct the calendar date.
export const GAME_HOURS_PER_DAY = 24;
export const GAME_DAYS_PER_MONTH = 30;
export const GAME_MONTHS_PER_YEAR = 12;
export const GAME_DAYS_PER_YEAR = GAME_DAYS_PER_MONTH * GAME_MONTHS_PER_YEAR;

