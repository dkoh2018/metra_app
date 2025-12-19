/**
 * Shared utility for generating Metra schedule URLs.
 * Used by both the client (for "Tracker" links) and server (for scraping crowding data).
 */

export interface MetraUrlOptions {
  origin: string;
  destination: string;
  line?: string;
  date?: Date | number | string;
}

export function getMetraScheduleUrl({ 
  origin, 
  destination, 
  line = 'UP-NW', 
  date 
}: MetraUrlOptions): string {
  // Default to now if no date provided
  const targetDate = date ? new Date(date) : new Date();
  
  // Convert to timestamp (seconds)
  // If we want "schedulable" time that works well with Metra's site, usually a timestamp is safest.
  // Metra's site expects `time` parameter as unix timestamp (seconds).
  const timestamp = Math.floor(targetDate.getTime() / 1000);
  
  // Ensure we have valid strings
  const orig = origin || 'PALATINE';
  const dest = destination || 'OTC';
  const lineId = line || 'UP-NW';
  
  // Construct the URL
  // Parameters:
  // - line: Line ID (UP-NW, MD-W)
  // - orig: Origin Station ID (GTFS ID)
  // - dest: Destination Station ID (GTFS ID)
  // - time: Unix timestamp for the desired schedule time
  // - allstops: 0 (default view), 1 (show all stops)
  // - redirect: logic for their backend, seems to match time usually
  
  return `https://www.metra.com/schedules?line=${lineId}&orig=${orig}&dest=${dest}&time=${timestamp}&allstops=0&redirect=${timestamp}`;
}
