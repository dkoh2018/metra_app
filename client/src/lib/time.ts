
/**
 * Timezone utility for handling Metra (Chicago) time.
 * Uses native Intl.DateTimeFormat to avoid heavy dependencies.
 */

const CHICAGO_TIMEZONE = 'America/Chicago';

export function getChicagoTime(): Date {
  const now = new Date();
  const options = { timeZone: CHICAGO_TIMEZONE };
  const chicagoTimeStr = now.toLocaleString('en-US', options);
  return new Date(chicagoTimeStr);
}

export function formatChicagoTime(date: Date, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: CHICAGO_TIMEZONE,
    ...options
  }).format(date);
}

export function isWeekday(date: Date): boolean {
  // 0 = Sunday, 6 = Saturday
  const dayStr = formatChicagoTime(date, { weekday: 'long' });
  return dayStr !== 'Saturday' && dayStr !== 'Sunday';
}

export function getDayType(date: Date): 'weekday' | 'saturday' | 'sunday' {
  const dayStr = new Intl.DateTimeFormat('en-US', {
    timeZone: CHICAGO_TIMEZONE,
    weekday: 'long'
  }).format(date);

  if (dayStr === 'Saturday') return 'saturday';
  if (dayStr === 'Sunday') return 'sunday';
  return 'weekday';
}

/**
 * Get day type based on "Service Day" (Metra service extends past midnight).
 * Trains running between 12:00 AM and 3:30 AM are usually part of the *previous* day's schedule.
 */
export function getServiceDayType(date: Date): 'weekday' | 'saturday' | 'sunday' {
  // Clone date and subtract 3.5 hours to handle late night service (until 3:30 AM) as previous day
  const adjustedDate = new Date(date);
  adjustedDate.setMinutes(adjustedDate.getMinutes() - 210); // -3.5 hours
  return getDayType(adjustedDate);
}

export function getCurrentMinutesInChicago(): number {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CHICAGO_TIMEZONE,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  }).formatToParts(now);
  
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0');
  const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0');
  
  return hour * 60 + minute;
}

/**
 * Get Chicago date string in YYYY-MM-DD format
 */
export function getChicagoDateString(date?: Date): string {
  const d = date || new Date();
  return new Intl.DateTimeFormat('en-US', {
    timeZone: CHICAGO_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d).replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2');
}

/**
 * Format date for display (e.g., "Dec 16, Monday")
 */
export function formatChicagoDate(date: Date): { dateStr: string; dayName: string; monthDay: string } {
  const dateStr = getChicagoDateString(date);
  const dayName = formatChicagoTime(date, { weekday: 'long' });
  const monthDay = formatChicagoTime(date, { month: 'short', day: 'numeric' });
  
  return { dateStr, dayName, monthDay };
}

/**
 * Add days to a date in Chicago timezone
 */
export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/**
 * Check if a date is today in Chicago timezone
 */
export function isToday(date: Date): boolean {
  const today = getChicagoDateString();
  const checkDate = getChicagoDateString(date);
  return today === checkDate;
}

/**
 * Check if a date is in the past (before today) in Chicago timezone
 */
export function isPastDate(date: Date): boolean {
  const today = getChicagoDateString();
  const checkDate = getChicagoDateString(date);
  return checkDate < today;
}
