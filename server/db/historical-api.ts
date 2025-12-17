import Database from 'better-sqlite3';
import { getDatabase } from './schema.js';

/**
 * Get historical delays for a specific date
 */
export function getHistoricalDelays(date: string): Array<{
  trip_id: string;
  stop_id: string;
  scheduled_time: string;
  actual_time: string;
  delay_seconds: number;
}> {
  const db = getDatabase();
  
  try {
    const results = db.prepare(`
      SELECT trip_id, stop_id, scheduled_time, actual_time, delay_seconds
      FROM historical_delays
      WHERE date = ?
      ORDER BY scheduled_time
    `).all(date) as Array<{
      trip_id: string;
      stop_id: string;
      scheduled_time: string;
      actual_time: string;
      delay_seconds: number;
    }>;
    
    db.close();
    return results;
  } catch (error: any) {
    db.close();
    return [];
  }
}

/**
 * Get delay for a specific trip and stop on a specific date
 */
export function getDelayForTrip(date: string, tripId: string, stopId: string): number {
  const db = getDatabase();
  
  try {
    const result = db.prepare(`
      SELECT delay_seconds
      FROM historical_delays
      WHERE date = ? AND trip_id = ? AND stop_id = ?
      ORDER BY recorded_at DESC
      LIMIT 1
    `).get(date, tripId, stopId) as { delay_seconds: number } | undefined;
    
    db.close();
    return result?.delay_seconds || 0;
  } catch (error: any) {
    db.close();
    return 0;
  }
}

