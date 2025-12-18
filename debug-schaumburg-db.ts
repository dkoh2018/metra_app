
import { getDatabase } from './server/db/schema.js';

// Initialize DB
const db = getDatabase();

console.log('--- Checking Schaumburg Schedule Data ---');

// Check stop_id variants
const idsToCheck = ['SCHAUM', 'SCHAUMBURG', 'SCHAUMBUR'];

for (const id of idsToCheck) {
  const count = db.prepare('SELECT COUNT(*) as count FROM schedules WHERE stop_id = ?').get(id);
  console.log(`Stop ID '${id}': found ${count.count} entries`);
}

// Check sample data for 'SCHAUM'
const sample = db.prepare(`
  SELECT 
    t.trip_id, 
    t.route_id, 
    t.direction_id, 
    s.arrival_time, 
    s.departure_time 
  FROM schedules s
  JOIN trips t ON s.trip_id = t.trip_id
  WHERE s.stop_id = 'SCHAUM'
  LIMIT 5
`).all();

console.log('\nSample Schaumburg Trains:', sample);

// Check total MD-W trips
const mdwTrips = db.prepare("SELECT COUNT(*) as count FROM trips WHERE route_id = 'MD-W'").get();
console.log(`\nTotal MD-W Trips in DB: ${mdwTrips.count}`);
