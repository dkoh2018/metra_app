
import { getAllSchedules } from '../server/db/schedule-api';
import { loadGTFSIntoDatabase } from '../server/db/gtfs-loader';

async function verify() {
  console.log('Reloading GTFS data to apply new loader logic...');
  await loadGTFSIntoDatabase();

  console.log('Fetching schedules...');
  const schedules = getAllSchedules();

  // Check Inbound
  const inbound = schedules.weekday.inbound;
  console.log(`Found ${inbound.length} inbound trains`);
  if (inbound.length > 0) {
    const first = inbound[0];
    console.log('Sample Inbound Train:', first);
    // Verify it's not just Palatine-OTC (unless that matches the line)
    // Actually, we can't easily verify the *location* from the object since we removed stop_id from the return type in some places?
    // Wait, the interface is:
    // interface TrainSchedule { trip_id: string; departure_time: string; arrival_time: string; is_express: boolean; }
    // We don't return the start/end stop names in the API response currently, just the times.
    // But we can verify the times match the full run.
    console.log(`Departure: ${first.departure_time}, Arrival: ${first.arrival_time}`);
  }

  // Check Outbound
  const outbound = schedules.weekday.outbound;
  console.log(`Found ${outbound.length} outbound trains`);
  if (outbound.length > 0) {
    const first = outbound[0];
    console.log('Sample Outbound Train:', first);
    console.log(`Departure: ${first.departure_time}, Arrival: ${first.arrival_time}`);
  }
}

verify().catch(console.error);
