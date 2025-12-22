export const MAX_CONCURRENT_SCRAPES = 3; // Limit parallel tabs to save memory

// Active hours: 4 AM - 6 PM Chicago time (commute hours)
// Off hours: 6 PM - 4 AM Chicago time (reduced polling)

export function isActiveHours(): boolean {
  const now = new Date();
  // Get Chicago time (handles DST automatically)
  const chicagoHour = parseInt(now.toLocaleString('en-US', { 
    timeZone: 'America/Chicago', 
    hour: 'numeric', 
    hour12: false 
  }));
  return chicagoHour >= 4 && chicagoHour < 18; // 4 AM to 6 PM
}

// Cache TTLs - different for active vs off hours
export const POSITIONS_CACHE_TTL = 15 * 1000; // 15 seconds (positions come from free GTFS API)

// Crowding cache: 1 hour active, 4 hours off
export function getCrowdingCacheTTL(): number {
  return isActiveHours() ? 10 * 60 * 1000 : 60 * 60 * 1000; // 10min active, 1hr off-hours
}

// Weather intervals: 15 min active, 30 min off  
export function getWeatherInterval(): number {
  return isActiveHours() ? 15 * 60 * 1000 : 30 * 60 * 1000; // 15min or 30min
}
