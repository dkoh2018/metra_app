/**
 * Shared utility for generating Metra schedule URLs.
 * Used by both the client (for "Tracker" links) and server (for scraping crowding data).
 */

export interface MetraUrlOptions {
  origin: string;
  destination: string;
  line: string;
  date?: Date | number | string;
}

export function getMetraScheduleUrl({ 
  origin, 
  destination, 
  line, 
  date 
}: MetraUrlOptions): string {
  // Default to now if no date provided
  const targetDate = date ? new Date(date) : new Date();
  
  // Convert to timestamp (seconds)
  // If we want "schedulable" time that works well with Metra's site, usually a timestamp is safest.
  // Metra's site expects `time` parameter as unix timestamp (seconds).
  const timestamp = Math.floor(targetDate.getTime() / 1000);
  
  // Use passed values directly - callers are responsible for providing valid station/line IDs
  const orig = origin;
  const dest = destination;
  const lineId = line;
  
  // Construct the URL
  // Parameters:
  // - line: Line ID (UP-NW, MD-W)
  // - orig: Origin Station ID (GTFS ID)
  // - dest: Destination Station ID (GTFS ID)
  // - time: Unix timestamp for the desired schedule time
  // - allstops: 0 (default view), 1 (show all stops)
  // Note: Removed 'redirect' parameter that was using current time and potentially
  // overriding our 4 AM schedule request. We want the full day's schedule.
  return `https://www.metra.com/schedules?line=${lineId}&orig=${orig}&dest=${dest}&time=${timestamp}&allstops=0`;
}
