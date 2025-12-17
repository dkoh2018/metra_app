
import { getScheduleForDayType } from '../server/db/schedule-api';
import { getDatabase } from '../server/db/schema';

function diagnose() {
  const db = getDatabase();
  console.log('--- Diagnosis Start ---');

  // 1. Check raw schedule counts
  const count = db.prepare('SELECT count(*) as c FROM schedules').get();
  console.log('Total schedule rows:', count);

  // 2. Check if we have Palatine stops
  const palatineCount = db.prepare("SELECT count(*) as c FROM schedules WHERE stop_id = 'PALATINE'").get();
  console.log('Palatine stops:', palatineCount);
  
  // 3. Check for specific train #620 (from screenshot)
  const train620 = db.prepare("SELECT * FROM schedules WHERE trip_id LIKE '%UNW620%' ORDER BY stop_sequence").all();
  console.log('Train #620 stops in DB:', train620.length);
  if (train620.length > 0) {
    console.log('Train #620 stops:', train620.map(s => `${s.stop_id} @ ${s.departure_time}`).join(' -> '));
  }

  // 4. Test API response for weekday
  console.log('\n--- Testing API Response (Weekday) ---');
  const schedule = getScheduleForDayType('weekday');
  console.log(`Inbound trains found: ${schedule.inbound.length}`);
  if (schedule.inbound.length > 0) {
    console.log('First 3 inbound:', schedule.inbound.slice(0, 3));
  }
}

diagnose();
