
import { getDatabase, initDatabase } from '../db/schema.js';

// Initialize DB
initDatabase();
const db = getDatabase();

if (!db) {
  console.error("Failed to connect to database!");
  process.exit(1);
}

const TEST_ORIGIN = 'PALATINE';
const TEST_DEST = 'OTC';

console.log(`\n🌱 Seeding DELAY TEST DATA for ${TEST_ORIGIN} -> ${TEST_DEST}...`);

// Find the next few trains using schedule table
const realTrips = db.prepare(`
  SELECT trip_id, departure_time 
  FROM schedules 
  WHERE stop_id = ? AND trip_id LIKE ?
  ORDER BY departure_time ASC
  LIMIT 5
`).all(TEST_ORIGIN, 'UP-NW_%');

if (realTrips.length === 0) {
  console.error("No real trips found! Cannot seed delay data.");
  process.exit(1);
}

const transaction = db.transaction(() => {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO crowding_cache 
    (origin, destination, trip_id, crowding, 
     scheduled_departure, predicted_departure, 
     scheduled_arrival, predicted_arrival, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);

  console.log(`Found ${realTrips.length} upcoming trips.`);

  // TRAIN 1: 5 minutes LATE (Red Time)
  if (realTrips[0]) {
    const trip = realTrips[0];
    const sched = trip.departure_time; // HH:MM:SS
    const [h, m] = sched.split(':').map(Number);
    
    // Add 5 mins
    const d = new Date(); d.setHours(h, m + 5, 0); // Handle rollover simply
    const predH = d.getHours();
    const predM = d.getMinutes();
    const predTime = `${predH}:${predM.toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
    
    // Format for display (HH:MM AM/PM) roughly matches what scraper does, 
    // but DB stores standard time string or whatever scraper stores.
    // Scraper usually stores "4:47 AM". Our DB schema stores text. 
    // Let's match scraper format: "H:MM AM/PM"
    const displaySched = `${h > 12 ? h - 12 : (h === 0 ? 12 : h)}:${m.toString().padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
    const displayPred = `${predH > 12 ? predH - 12 : (predH === 0 ? 12 : predH)}:${predM.toString().padStart(2, '0')} ${predH >= 12 ? 'PM' : 'AM'}`;

    console.log(`Train 1 (${trip.trip_id}): LATE by 5 mins (${displaySched} -> ${displayPred})`);
    
    insert.run(TEST_ORIGIN, TEST_DEST, trip.trip_id, 'low', displaySched, displayPred, null, null);
  }

  // TRAIN 2: 2 minutes EARLY (Green Time)
  if (realTrips[1]) {
    const trip = realTrips[1];
    const sched = trip.departure_time;
    const [h, m] = sched.split(':').map(Number);
    
    // Subtract 2 mins
    const d = new Date(); d.setHours(h, m - 2, 0);
    const predH = d.getHours();
    const predM = d.getMinutes();
    
    const displaySched = `${h > 12 ? h - 12 : (h === 0 ? 12 : h)}:${m.toString().padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
    const displayPred = `${predH > 12 ? predH - 12 : (predH === 0 ? 12 : predH)}:${predM.toString().padStart(2, '0')} ${predH >= 12 ? 'PM' : 'AM'}`;

    console.log(`Train 2 (${trip.trip_id}): EARLY by 2 mins (${displaySched} -> ${displayPred})`);

    insert.run(TEST_ORIGIN, TEST_DEST, trip.trip_id, 'low', displaySched, displayPred, null, null);
  }
   
   // TRAIN 3: ON TIME (Normal)
   if (realTrips[2]) {
     const trip = realTrips[2];
     const sched = trip.departure_time;
     const [h, m] = sched.split(':').map(Number);
     const displaySched = `${h > 12 ? h - 12 : (h === 0 ? 12 : h)}:${m.toString().padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
     
     console.log(`Train 3 (${trip.trip_id}): ON TIME (${displaySched})`);
     
     // Predicted == Scheduled
     insert.run(TEST_ORIGIN, TEST_DEST, trip.trip_id, 'low', displaySched, displaySched, null, null);
   }

});

transaction();
console.log("✅ Delay test data seeded!");
