import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { initDatabase } from './schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In production, dist/index.js runs from /app/dist, but GTFS is at /app/server/gtfs/data
// In development, this file is at server/db/gtfs-loader.ts and GTFS is at server/gtfs/data
const GTFS_DIR = process.env.NODE_ENV === 'production'
  ? path.resolve(process.cwd(), 'server/gtfs/data')
  : path.resolve(__dirname, '../gtfs/data');

interface StopTime {
  trip_id: string;
  arrival_time: string;
  departure_time: string;
  stop_id: string;
  stop_sequence: string;
}

interface Trip {
  route_id: string;
  service_id: string;
  trip_id: string;
  direction_id: string;
  trip_headsign: string;
}

interface Calendar {
  service_id: string;
  monday: string;
  tuesday: string;
  wednesday: string;
  thursday: string;
  friday: string;
  saturday: string;
  sunday: string;
  start_date: string;
  end_date: string;
}

function cleanRow(row: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k.trim(), typeof v === 'string' ? v.trim() : v])
  );
}

function parseCSV(filePath: string): Record<string, string>[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length === 0) return [];
  
  const headers = lines[0].split(',').map(h => h.trim());
  const rows: Record<string, string>[] = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    const row: Record<string, string> = {};
    headers.forEach((header, idx) => {
      row[header] = values[idx]?.trim() || '';
    });
    rows.push(cleanRow(row));
  }
  
  return rows;
}

export async function loadGTFSIntoDatabase(): Promise<void> {
  const db = initDatabase();
  const transaction = db.transaction(() => {
    // Clear existing data
    db.exec('DELETE FROM schedules');
    db.exec('DELETE FROM service_calendar');
    
    // Load trips
    const trips = parseCSV(path.join(GTFS_DIR, 'trips.txt')) as unknown as Trip[];
    const tripsByRoute = trips.filter(t => t.route_id === 'UP-NW');
    console.log(`Found ${tripsByRoute.length} UP-NW trips`);
    
    // Load calendar
    const calendars = parseCSV(path.join(GTFS_DIR, 'calendar.txt')) as unknown as Calendar[];
    const calendarMap = new Map<string, Calendar>();
    calendars.forEach(cal => {
      calendarMap.set(cal.service_id, cal);
    });
    
    // Insert calendar data
    const insertCalendar = db.prepare(`
      INSERT OR REPLACE INTO service_calendar 
      (service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    calendars.forEach(cal => {
      insertCalendar.run(
        cal.service_id,
        parseInt(cal.monday) || 0,
        parseInt(cal.tuesday) || 0,
        parseInt(cal.wednesday) || 0,
        parseInt(cal.thursday) || 0,
        parseInt(cal.friday) || 0,
        parseInt(cal.saturday) || 0,
        parseInt(cal.sunday) || 0,
        cal.start_date,
        cal.end_date
      );
    });
    
    // Load stop_times
    const stopTimes = parseCSV(path.join(GTFS_DIR, 'stop_times.txt')) as unknown as StopTime[];
    const tripIds = new Set(tripsByRoute.map(t => t.trip_id));
    const relevantStopTimes = stopTimes.filter(st => tripIds.has(st.trip_id));
    
    console.log(`Found ${relevantStopTimes.length} stop times for UP-NW trips`);
    
    // Group stop times by trip
    const stopTimesByTrip = new Map<string, StopTime[]>();
    relevantStopTimes.forEach(st => {
      if (!stopTimesByTrip.has(st.trip_id)) {
        stopTimesByTrip.set(st.trip_id, []);
      }
      stopTimesByTrip.get(st.trip_id)!.push(st);
    });
    
    // Determine express trains (trains with fewer stops between Palatine and OTC)
    const PALATINE_STOP = 'PALATINE';
    const OTC_STOP = 'OTC';
    
    const insertSchedule = db.prepare(`
      INSERT INTO schedules 
      (route_id, trip_id, service_id, direction, stop_id, stop_sequence, arrival_time, departure_time, is_express)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    let inserted = 0;
    for (const trip of tripsByRoute) {
      const tripStopTimes = stopTimesByTrip.get(trip.trip_id) || [];
      if (tripStopTimes.length < 2) continue; // Need at least start and end

      tripStopTimes.sort((a, b) => parseInt(a.stop_sequence) - parseInt(b.stop_sequence));
      
      // Get Origin (first stop) and Destination (last stop)
      const originStop = tripStopTimes[0];
      const destinationStop = tripStopTimes[tripStopTimes.length - 1];
      
      // Determine direction (1 = outbound to Harvard/McHenry, 0 = inbound to Chicago)
      // GTFS standard: 0 is usually one direction, 1 the other. For Metra UP-NW:
      // Even train numbers are inbound (to Chicago), Odd are outbound.
      // But we can also check stop sequence or standard direction_id if available.
      // Let's stick to the reliable logic: Chicago OTC is stop_id 'OTC'.
      
      let direction = 'outbound';
      if (destinationStop.stop_id === 'OTC') {
        direction = 'inbound';
      } else if (originStop.stop_id === 'OTC') {
        direction = 'outbound';
      } else {
        // Fallback for partial trips that might not touch OTC (rare but possible)
        // Check standard direction_id from trips.txt if we had it, or assume based on sequence
        // For UP-NW, 'OTC' is roughly sequence 1 or very low.
        // Let's rely on the trip direction_id if defined, otherwise infer.
        // The current trip object has direction_id.
        direction = trip.direction_id === '1' ? 'outbound' : 'inbound';
      }
      
      
      // Calculate is_express
      // For now, let's say if it has fewer than 15 stops it's likely express/limited
      const isExpress = tripStopTimes.length < 15;
      
      // Insert ALL stops for the trip
      for (const stopTime of tripStopTimes) {
        insertSchedule.run(
          trip.route_id,
          trip.trip_id,
          trip.service_id,
          direction,
          stopTime.stop_id,
          parseInt(stopTime.stop_sequence),
          stopTime.arrival_time,
          stopTime.departure_time,
          isExpress ? 1 : 0
        );
      }
        
      inserted += 2;
    }
    
    console.log(`Inserted ${inserted} schedule records`);
    
    // Update metadata
    try {
      const publishedDatePath = path.join(GTFS_DIR, '..', 'published.txt');
      let publishedDate = new Date().toISOString().split('T')[0]; // Default to today if file doesn't exist
      
      if (fs.existsSync(publishedDatePath)) {
        publishedDate = fs.readFileSync(publishedDatePath, 'utf-8').trim();
      }
      
      const insertMetadata = db.prepare(`
        INSERT OR REPLACE INTO gtfs_metadata (published_date, last_updated)
        VALUES (?, CURRENT_TIMESTAMP)
      `);
      insertMetadata.run(publishedDate);
    } catch (error: any) {
      console.warn('Could not update GTFS metadata:', error.message);
      // Continue anyway - metadata is optional
    }
    
    console.log('GTFS data loaded successfully!');
  });
  
  transaction();
  db.close();
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  loadGTFSIntoDatabase().catch(console.error);
}

