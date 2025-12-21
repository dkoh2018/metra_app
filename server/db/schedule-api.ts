import Database from 'better-sqlite3';
import { getDatabase } from './schema.js';

import type { ServerTrainSchedule as TrainSchedule } from '@shared/types';

export type { TrainSchedule };

export interface DayType {
  type: 'weekday' | 'saturday' | 'sunday';
  inbound: TrainSchedule[];
  outbound: TrainSchedule[];
}

// Cache service IDs per day type (key: dayType_date)
const serviceIdCache = new Map<string, string[]>();

/**
 * Get current date in YYYYMMDD format for Chicago
 */
function getCurrentDateString(): string {
  // TODO: Revert this hardcoded date after testing or when 2024 data is available
  // Hardcoding to Jan 4, 2025 (Saturday) to verify UP-W data which starts Jan 1, 2025
  return '20250104';
  
  /*
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date()).replace(/-/g, '');
  */
}

/**
 * Get service IDs for a specific day type (cached by dayType + date)
 */
function getServiceIdsForDayType(dayType: 'weekday' | 'saturday' | 'sunday'): string[] {
  const currentDate = getCurrentDateString();
  const cacheKey = `${dayType}_${currentDate}`;
  
  // Return cached value if available
  // Note: key includes date, so it auto-refreshes daily
  if (serviceIdCache.has(cacheKey as any)) {
    return serviceIdCache.get(cacheKey as any)!;
  }
  
  const db = getDatabase();
  
  // Determine which service_ids match this day type
  let dayColumn = '';
  if (dayType === 'weekday') {
    dayColumn = 'monday = 1 AND saturday = 0 AND sunday = 0';
  } else if (dayType === 'saturday') {
    dayColumn = 'saturday = 1';
  } else {
    dayColumn = 'sunday = 1';
  }
  
  // Filter by date range to avoid overlapping schedule versions (e.g. standard vs holiday)
  const serviceIds = db.prepare(`
    SELECT service_id FROM service_calendar 
    WHERE ${dayColumn}
      AND start_date <= ? 
      AND end_date >= ?
  `).all(currentDate, currentDate) as Array<{ service_id: string }>;
  
  const serviceIdList = serviceIds.map(s => s.service_id);
  
  // Cache the result
  serviceIdCache.set(cacheKey as any, serviceIdList);
  
  return serviceIdList;
}

/**
 * Get schedule for a specific day type
 */
/**
 * Get schedule for a specific day type
 */
export function getScheduleForDayType(
  dayType: 'weekday' | 'saturday' | 'sunday',
  stationId: string = 'PALATINE',
  terminalId: string = 'OTC'
): DayType {
  const db = getDatabase();
  const serviceIdList = getServiceIdsForDayType(dayType);
  
  if (serviceIdList.length === 0) {
    // Don't close - connection is reused
    return { type: dayType, inbound: [], outbound: [] };
  }
  
  const placeholders = serviceIdList.map(() => '?').join(',');
  
  // Get inbound trains
  // Deduplicate by departure_time and arrival_time to avoid multiple service variants
  // s1 = Origin (Start of trip, min sequence)
  // s2 = Destination (End of trip, max sequence)
  // Get inbound trains (Selected Station -> Terminal)
  const inboundTrains = db.prepare(`
    SELECT 
      MIN(s1.trip_id) as trip_id,
      s1.departure_time as departure_time,
      s2.arrival_time as arrival_time,
      MAX(s1.is_express) as is_express
    FROM schedules s1
    JOIN schedules s2 ON s1.trip_id = s2.trip_id
    WHERE s1.direction = 'inbound'
      AND s1.service_id IN (${placeholders})
      AND s1.stop_id = ?
      AND s2.stop_id = ?
    GROUP BY s1.departure_time, s2.arrival_time
    ORDER BY s1.departure_time
  `).all(...serviceIdList, stationId, terminalId) as TrainSchedule[];
  
  // Get outbound trains (Terminal -> Selected Station)
  const outboundTrains = db.prepare(`
    SELECT 
      MIN(s1.trip_id) as trip_id,
      s1.departure_time as departure_time,
      s2.arrival_time as arrival_time,
      MAX(s1.is_express) as is_express
    FROM schedules s1
    JOIN schedules s2 ON s1.trip_id = s2.trip_id
    WHERE s1.direction = 'outbound'
      AND s1.service_id IN (${placeholders})
      AND s1.stop_id = ?
      AND s2.stop_id = ?
    GROUP BY s1.departure_time, s2.arrival_time
    ORDER BY s1.departure_time
  `).all(...serviceIdList, terminalId, stationId) as TrainSchedule[];
  
  // Don't close - connection is reused for better performance
  
  return {
    type: dayType,
    inbound: inboundTrains,
    outbound: outboundTrains
  };
}

/**
 * Get all schedules (weekday, saturday, sunday)
 * Uses in-memory cache to avoid DB queries on every HTML injection
 */
const scheduleCache = new Map<string, {
  data: { weekday: DayType; saturday: DayType; sunday: DayType };
  timestamp: number;
}>();
const SCHEDULE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes - schedules are static GTFS data

export function getAllSchedules(stationId: string = 'PALATINE', terminalId: string = 'OTC'): {
  weekday: DayType;
  saturday: DayType;
  sunday: DayType;
} {
  const cacheKey = `${stationId}_${terminalId}`;
  const now = Date.now();
  const cached = scheduleCache.get(cacheKey);
  
  // Return cached data if still valid
  if (cached && (now - cached.timestamp) < SCHEDULE_CACHE_TTL) {
    return cached.data;
  }
  
  // Fetch fresh data and cache it
  const data = {
    weekday: getScheduleForDayType('weekday', stationId, terminalId),
    saturday: getScheduleForDayType('saturday', stationId, terminalId),
    sunday: getScheduleForDayType('sunday', stationId, terminalId)
  };
  
  scheduleCache.set(cacheKey, { data, timestamp: now });
  return data;
}

/**
 * Get next train for a given direction and current time
 */
export function getNextTrain(
  direction: 'inbound' | 'outbound',
  currentTimeMinutes: number,
  dayType: 'weekday' | 'saturday' | 'sunday',
  stationId: string = 'PALATINE',
  terminalId: string = 'OTC'
): TrainSchedule | null {
  const schedule = getScheduleForDayType(dayType, stationId, terminalId);
  const trains = direction === 'inbound' ? schedule.inbound : schedule.outbound;
  
  const timeToMinutes = (timeStr: string): number => {
    const [hours, minutes] = timeStr.split(':').map(Number);
    return hours * 60 + minutes;
  };
  
  // Find first train after current time
  const next = trains.find(train => {
    const depMinutes = timeToMinutes(train.departure_time);
    return depMinutes > currentTimeMinutes;
  });
  
  return next || trains[0] || null;
}

/**
 * Get current day of week in Chicago timezone (0 = Sunday, 1 = Monday, etc.)
 */
function getChicagoDayOfWeek(): number {
  const chicagoTime = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short'
  }).format(new Date());
  
  const dayMap: Record<string, number> = {
    'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6
  };
  return dayMap[chicagoTime] ?? 0;
}

/**
 * Get current hour in Chicago timezone (0-23)
 */
function getChicagoHour(): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric',
    hour12: false
  }).formatToParts(new Date());
  
  const hourPart = parts.find(p => p.type === 'hour');
  return parseInt(hourPart?.value || '0');
}

/**
 * Check if GTFS data needs updating
 * - On Monday 3-4 AM Chicago time: update if more than 6 days old (weekly refresh)
 * - On any startup: update if more than 7 days old (catches missed Mondays)
 * - Force update if more than 14 days old (failsafe)
 */
export function shouldUpdateGTFS(): boolean {
  const db = getDatabase();
  const metadata = db.prepare(`
    SELECT published_date, last_updated FROM gtfs_metadata 
    ORDER BY last_updated DESC LIMIT 1
  `).get() as { published_date: string; last_updated: string } | undefined;
  
  // Don't close - connection is reused
  
  // No data yet - need to load
  if (!metadata) {
    console.log('📅 GTFS: No metadata found, will load fresh data');
    return true;
  }
  
  // Calculate days since last update
  const lastUpdate = new Date(metadata.last_updated);
  const now = new Date();
  const daysSinceUpdate = (now.getTime() - lastUpdate.getTime()) / (1000 * 60 * 60 * 24);
  
  // Check if it's Monday between 3-4 AM Chicago time (schedule update window)
  const isMonday = getChicagoDayOfWeek() === 1;
  const chicagoHour = getChicagoHour();
  const isUpdateWindow = isMonday && chicagoHour >= 3 && chicagoHour < 4;
  
  // Monday update window: update if more than 6 days old
  if (isUpdateWindow && daysSinceUpdate >= 6) {
    console.log(`📅 GTFS: Monday update window (3-4 AM Chicago), ${daysSinceUpdate.toFixed(1)} days since last update - updating`);
    return true;
  }
  
  // Startup check: update if data is more than 7 days old (catches missed Mondays)
  if (daysSinceUpdate >= 7) {
    console.log(`📅 GTFS: Data is ${daysSinceUpdate.toFixed(1)} days old (>7 days), updating in background`);
    return true;
  }
  
  // Force update if more than 14 days old (failsafe)
  if (daysSinceUpdate >= 14) {
    console.log(`📅 GTFS: Data is ${daysSinceUpdate.toFixed(1)} days old (>14 days), forcing update`);
    return true;
  }
  
  // Data is fresh enough
  const ageDescription = daysSinceUpdate < 0 ? 'just updated' : `${daysSinceUpdate.toFixed(1)} days old`;
  console.log(`📅 GTFS: Data is ${ageDescription}, no update needed`);
  return false;
}

/**
 * Get the last GTFS update info for display/tracking
 */
export function getGTFSUpdateInfo(): { 
  lastUpdated: string | null; 
  publishedDate: string | null;
  daysSinceUpdate: number | null;
} {
  try {
    const db = getDatabase();
    const metadata = db.prepare(`
      SELECT published_date, last_updated FROM gtfs_metadata 
      ORDER BY last_updated DESC LIMIT 1
    `).get() as { published_date: string; last_updated: string } | undefined;
    
    if (!metadata) {
      return { lastUpdated: null, publishedDate: null, daysSinceUpdate: null };
    }
    
    const lastUpdate = new Date(metadata.last_updated);
    const now = new Date();
    const daysSinceUpdate = (now.getTime() - lastUpdate.getTime()) / (1000 * 60 * 60 * 24);
    
    return {
      lastUpdated: metadata.last_updated,
      publishedDate: metadata.published_date,
      daysSinceUpdate: Math.round(daysSinceUpdate * 10) / 10
    };
  } catch {
    return { lastUpdated: null, publishedDate: null, daysSinceUpdate: null };
  }
}

