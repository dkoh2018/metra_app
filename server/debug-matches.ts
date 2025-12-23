import 'dotenv/config';
import axios from 'axios';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { getDatabase } from './db/schema.js';

async function checkTripIds() {
  const token = process.env.VITE_METRA_API_TOKEN;
  if (!token) {
    console.error("No token found in environment!");
    return;
  }
  
  const url = `https://gtfspublic.metrarr.com/gtfs/public/positions`;
  console.log("Fetching positions...");
  
  try {
    const response = await axios.get(url, {
      responseType: "arraybuffer",
      params: { api_token: token }
    });

    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(response.data));
    const entities = feed.entity;
    
    const db = getDatabase();
    
    let matches = 0;
    let mismatches = 0;
    
    console.log("Checking trips...");
    
    for (const entity of entities) {
      if (!entity.vehicle || !entity.vehicle.trip) continue;
      const tripId = entity.vehicle.trip.tripId;
      const routeId = entity.vehicle.trip.routeId;
      
      // Filter for our lines only
      if (typeof routeId === 'string' && !['UP-NW', 'MD-W', 'UP-N', 'BNSF', 'UP-W'].includes(routeId)) continue;
      
      // Check DB
      const result = db.prepare('SELECT COUNT(*) as c FROM schedules WHERE trip_id = ?').get(String(tripId)) as { c: number };
      
      if (result.c > 0) {
        matches++;
        if (matches === 1) {
            console.log(`\n🔍 Inspecting Trip ${tripId}...`);
            const schedule = db.prepare('SELECT * FROM schedules WHERE trip_id = ?').all(String(tripId));
            console.log(`Found ${schedule.length} stops.`);
            console.log('Sample Stop:', schedule[0]);
        }
      } else {
        mismatches++;
        console.log(`❌ Mismatch: Route ${routeId}, Trip ${tripId} not found in DB.`);
      }
    }
    
    console.log(`\nSummary:`);
    console.log(`✅ Matches: ${matches}`);
    console.log(`❌ Mismatches: ${mismatches}`);
    
    if (mismatches > 0) {
      console.log("\nPossible Cause: The 'schedules' table data (from GTFS .txt files) is older than or incompatible with the current Realtime feed trip IDs.");
    }
  } catch (error: any) {
    console.error("Error:", error.message);
  }
}

checkTripIds();
