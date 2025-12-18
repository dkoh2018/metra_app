
import { getDatabase } from '../server/db/schema';

const db = getDatabase();

console.log('--- Database Integrity Check ---');

// 1. Check for Palatine stops with non-UP-NW routes
const palatineErrors = db.prepare(`
  SELECT count(*) as count 
  FROM schedules 
  WHERE stop_id = 'PALATINE' AND route_id != 'UP-NW'
`).get() as { count: number };

console.log(`\n1. Palatine (UP-NW) Integrity:`);
if (palatineErrors.count === 0) {
  console.log('✅ PASS: All Palatine stops are on UP-NW route.');
} else {
  console.log(`❌ FAIL: Found ${palatineErrors.count} Palatine stops with unexpected route_id.`);
  // Detail
  const details = db.prepare(`
    SELECT DISTINCT route_id 
    FROM schedules 
    WHERE stop_id = 'PALATINE' AND route_id != 'UP-NW'
  `).all();
  console.log('   Invalid routes present:', details);
}

// 2. Check for Schaumburg stops with non-MD-W routes
// First find the actual ID used
const schaumburgIds = db.prepare(`
  SELECT DISTINCT stop_id 
  FROM schedules 
  WHERE stop_id LIKE 'SCHAUM%'
`).all() as { stop_id: string }[];

if (schaumburgIds.length === 0) {
  console.log('\n⚠️ WARNING: No stops found matching "SCHAUM%". Is the data loaded?');
} else {
  console.log(`\nFound Schaumburg Stop IDs: ${schaumburgIds.map(s => s.stop_id).join(', ')}`);
  
  for (const stop of schaumburgIds) {
    const schaumburgErrors = db.prepare(`
      SELECT count(*) as count 
      FROM schedules 
      WHERE stop_id = ? AND route_id != 'MD-W'
    `).get(stop.stop_id) as { count: number };

    console.log(`\n2. ${stop.stop_id} (MD-W) Integrity:`);
    if (schaumburgErrors.count === 0) {
      console.log(`✅ PASS: All ${stop.stop_id} stops are on MD-W route.`);
    } else {
      console.log(`❌ FAIL: Found ${schaumburgErrors.count} stops with unexpected route_id.`);
      const details = db.prepare(`
        SELECT DISTINCT route_id 
        FROM schedules 
        WHERE stop_id = ? AND route_id != 'MD-W'
      `).all(stop.stop_id);
      console.log('   Invalid routes present:', details);
    }
  }
}

// 3. Check for Cross-Contamination (Trips containing BOTH Palatine and Schaumburg)
console.log('\n3. Cross-Contamination Check (Trips with both stops):');
const crossContamination = db.prepare(`
  SELECT s1.trip_id, s1.route_id 
  FROM schedules s1
  JOIN schedules s2 ON s1.trip_id = s2.trip_id
  WHERE s1.stop_id = 'PALATINE' 
  AND s2.stop_id LIKE 'SCHAUM%'
`).all();

if (crossContamination.length === 0) {
  console.log('✅ PASS: No trips found that stop at both Palatine and Schaumburg.');
} else {
  console.log(`❌ FAIL: Found ${crossContamination.length} trips stopping at both.`);
  console.log('Sample invalid trips:', crossContamination.slice(0, 5));
}

console.log('\n--- End Check ---');
