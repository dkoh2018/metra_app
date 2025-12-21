import Database from 'better-sqlite3';
import axios from 'axios';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { getDatabase } from './schema.js';

import { METRA_API } from '@shared/config';

const METRA_API_URL = METRA_API.GTFS_URL;

/**
 * Get list of stops we care about for real-time updates
 * Includes all highlighted stations and their terminals
 * This makes it modular - adding a new highlighted station automatically includes it
 */
function getMonitoredStops(): string[] {
  // Highlighted stations (stations with isHighlight: true)
  // IMPORTANT: Keep this in sync with STATIONS in client/src/lib/stations.ts
  const highlightedStations = ['PALATINE', 'SCHAUM', 'WILMETTE', 'WESTMONT'];
  
  // Terminals for each line
  const terminals = ['OTC', 'CUS'];
  
  return [...highlightedStations, ...terminals];
}

/**
 * Get Chicago date string in YYYY-MM-DD format
 */
function getChicagoDateString(): string {
  const now = new Date();
  // Format: YYYY-MM-DD
  const year = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric'
  }).format(now);
  const month = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    month: '2-digit'
  }).format(now);
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    day: '2-digit'
  }).format(now);
  return `${year}-${month}-${day}`;
}

/**
 * Fetch and update real-time trip updates from Metra API
 * This should be called periodically (every 30-60 seconds)
 * Also saves historical delay data for past dates
 */
export async function updateRealtimeData(apiToken: string): Promise<void> {
  const db = getDatabase();
  
  try {
    // Fetch trip updates
    const response = await axios.get(`${METRA_API_URL}/tripupdates`, {
      responseType: 'arraybuffer',
      params: { api_token: apiToken }
    });
    
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
      new Uint8Array(response.data)
    );
    
    // Handle empty feed gracefully (e.g., during off-hours when no trains are running)
    if (!feed.entity || feed.entity.length === 0) {
      console.log('⏸️  No train data available (likely off-hours - no trains running)');
      return;
    }
    
    // Use INSERT OR IGNORE to avoid conflicts with UNIQUE constraint
    // We want to keep historical updates, so we insert new rows rather than replacing
    // The getAllDelays() function will deduplicate by selecting the latest update
    const insertUpdate = db.prepare(`
      INSERT INTO realtime_updates 
      (trip_id, stop_id, scheduled_arrival, scheduled_departure, 
       predicted_arrival, predicted_departure, delay_seconds, update_timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(trip_id, stop_id, update_timestamp) DO UPDATE SET
        scheduled_arrival = excluded.scheduled_arrival,
        scheduled_departure = excluded.scheduled_departure,
        predicted_arrival = excluded.predicted_arrival,
        predicted_departure = excluded.predicted_departure,
        delay_seconds = excluded.delay_seconds
    `);
    
    const insertHistorical = db.prepare(`
      INSERT OR REPLACE INTO historical_delays
      (date, trip_id, stop_id, scheduled_time, actual_time, delay_seconds, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    
    const now = new Date();
    // Chicago time for timestamps
    const chicagoTime = now.toLocaleString('en-US', {
      timeZone: 'America/Chicago',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    }).replace(/(\d+)\/(\d+)\/(\d+),/, '$3-$1-$2'); // YYYY-MM-DD HH:MM:SS
    
    const chicagoDate = getChicagoDateString();
    
    const transaction = db.transaction(() => {
      // Clean old updates (older than 1 hour)
      db.prepare(`
        DELETE FROM realtime_updates 
        WHERE update_timestamp < datetime('now', '-1 hour')
      `).run();
      
      // Process each entity in the feed
      for (const entity of feed.entity) {
        if (entity.tripUpdate) {
          const tripId = entity.tripUpdate.trip?.tripId;
          if (!tripId) continue;
          
          // Only process stops we care about (highlighted stations and terminals)
          const monitoredStops = getMonitoredStops();
          for (const stopTimeUpdate of entity.tripUpdate.stopTimeUpdate || []) {
            const stopId = stopTimeUpdate.stopId;
            if (!stopId || !monitoredStops.includes(stopId)) continue;
            
            const scheduledArrival = stopTimeUpdate.scheduleRelationship === 1 // SCHEDULED
              ? stopTimeUpdate.arrival?.time?.toString()
              : stopTimeUpdate.arrival?.time?.toString();
            const scheduledDeparture = stopTimeUpdate.scheduleRelationship === 1
              ? stopTimeUpdate.departure?.time?.toString()
              : stopTimeUpdate.departure?.time?.toString();
            const predictedArrival = stopTimeUpdate.arrival?.time?.toString();
            const predictedDeparture = stopTimeUpdate.departure?.time?.toString();
            
            // Calculate delay
            let delaySeconds = 0;
            let scheduledTime: string | null = null;
            let actualTime: string | null = null;
            
            if (scheduledArrival && predictedArrival) {
              delaySeconds = parseInt(predictedArrival) - parseInt(scheduledArrival);
              scheduledTime = new Date(parseInt(scheduledArrival) * 1000).toISOString();
              actualTime = new Date(parseInt(predictedArrival) * 1000).toISOString();
            } else if (scheduledDeparture && predictedDeparture) {
              delaySeconds = parseInt(predictedDeparture) - parseInt(scheduledDeparture);
              scheduledTime = new Date(parseInt(scheduledDeparture) * 1000).toISOString();
              actualTime = new Date(parseInt(predictedDeparture) * 1000).toISOString();
            }
            
            // Insert real-time update
            insertUpdate.run(
              tripId,
              stopId,
              scheduledArrival ? new Date(parseInt(scheduledArrival) * 1000).toISOString() : null,
              scheduledDeparture ? new Date(parseInt(scheduledDeparture) * 1000).toISOString() : null,
              predictedArrival ? new Date(parseInt(predictedArrival) * 1000).toISOString() : null,
              predictedDeparture ? new Date(parseInt(predictedDeparture) * 1000).toISOString() : null,
              delaySeconds,
              chicagoTime
            );
            
            // Save to historical delays if we have the data
            if (scheduledTime && actualTime && delaySeconds !== 0) {
              // Extract just the time portion (HH:MM:SS)
              const scheduledTimeStr = scheduledTime.split('T')[1]?.split('.')[0] || '';
              const actualTimeStr = actualTime.split('T')[1]?.split('.')[0] || '';
              
              insertHistorical.run(
                chicagoDate,
                tripId,
                stopId,
                scheduledTimeStr,
                actualTimeStr,
                delaySeconds,
                chicagoTime
              );
            }
          }
        }
      }
    });
    
    transaction();
    console.log('Real-time data updated successfully');
    
  } catch (error: any) {
    console.error('\n❌ [REALTIME] Error updating real-time data:', error.message);
    if (error.response) {
      console.error(`   HTTP Status: ${error.response.status}`);
      console.error(`   Response size: ${error.response.data?.byteLength || 0} bytes`);
    }
    throw error;
  }
  // Don't close the database connection - let it be reused
  // The connection will be reused by getDatabase() for better performance
}

/**
 * Get real-time delay for a specific trip and stop
 */
export function getRealtimeDelay(tripId: string, stopId: string): number {
  const db = getDatabase();
  
  const result = db.prepare(`
    SELECT delay_seconds FROM realtime_updates
    WHERE trip_id = ? AND stop_id = ?
      AND update_timestamp > datetime('now', '-5 minutes')
    ORDER BY update_timestamp DESC
    LIMIT 1
  `).get(tripId, stopId) as { delay_seconds: number } | undefined;
  
  // Don't close - connection is reused
  return result?.delay_seconds || 0;
}

/**
 * Get all current delays for trains at monitored stops (highlighted stations and terminals)
 * Returns predicted times for better delay visibility
 * Deduplicates by trip_id and stop_id to return only the latest update for each trip/stop combination
 */
export function getAllDelays(): Array<{ 
  trip_id: string; 
  stop_id: string; 
  delay_seconds: number;
  scheduled_arrival?: string | null;
  scheduled_departure?: string | null;
  predicted_arrival?: string | null;
  predicted_departure?: string | null;
}> {
  const db = getDatabase();
  
  // Get list of monitored stops (highlighted stations + terminals)
  const monitoredStops = getMonitoredStops();
  const placeholders = monitoredStops.map(() => '?').join(',');
  
  // Use a subquery to get only the latest update for each trip_id/stop_id combination
  // This ensures we don't return duplicate entries for the same train/stop
  // Deduplicate by trip_id and stop_id to get only the latest update
  // This ensures we don't return multiple rows for the same train/stop combination
  const results = db.prepare(`
    SELECT r1.trip_id, r1.stop_id, r1.delay_seconds,
           r1.scheduled_arrival, r1.scheduled_departure,
           r1.predicted_arrival, r1.predicted_departure
    FROM realtime_updates r1
    INNER JOIN (
      SELECT trip_id, stop_id, MAX(update_timestamp) as max_timestamp
      FROM realtime_updates
      WHERE stop_id IN (${placeholders})
        AND update_timestamp > datetime('now', '-5 minutes')
      GROUP BY trip_id, stop_id
    ) r2 ON r1.trip_id = r2.trip_id 
         AND r1.stop_id = r2.stop_id 
         AND r1.update_timestamp = r2.max_timestamp
    ORDER BY r1.update_timestamp DESC
  `).all(...monitoredStops) as Array<{ 
    trip_id: string; 
    stop_id: string; 
    delay_seconds: number;
    scheduled_arrival?: string | null;
    scheduled_departure?: string | null;
    predicted_arrival?: string | null;
    predicted_departure?: string | null;
  }>;
  
  // Don't close - connection is reused for better performance
  return results;
}

