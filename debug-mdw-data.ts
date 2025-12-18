
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

// 1. Setup DB Connection (simulating server path)
const dbPath = path.resolve(process.cwd(), 'metra.db');
console.log(`Open DB: ${dbPath}`);
const db = new Database(dbPath, { readonly: true });

try {
    // 2. Check Trips Table
    const tripsCount = db.prepare("SELECT COUNT(*) as c FROM trips").get() as {c: number};
    console.log(`Total Trips: ${tripsCount.c}`);

    // 3. Check MD-W Trips and Terminal
    console.log('\n--- MD-W Terminal Check ---');
    const mdwTrip = db.prepare("SELECT trip_id FROM trips WHERE route_id = 'MD-W' LIMIT 1").get() as {trip_id: string};
    
    if (mdwTrip) {
        console.log(`Sample MD-W Trip: ${mdwTrip.trip_id}`);
        // Get the last stop for this trip
        const stops = db.prepare(`
            SELECT s.stop_id, s.stop_sequence 
            FROM schedules s 
            WHERE s.trip_id = ? 
            ORDER BY s.stop_sequence DESC 
            LIMIT 1
        `).get(mdwTrip.trip_id) as {stop_id: string, stop_sequence: number};
        console.log(`Final Stop ID for MD-W (Inbound?): ${stops.stop_id}`);
    } else {
        console.log('No MD-W trips found!');
    }

    // 4. Check CUS existence
    const cus = db.prepare("SELECT * FROM schedules WHERE stop_id = 'CUS' LIMIT 1").get();
    console.log(`\nIs 'CUS' present in schedules? ${!!cus}`);
    
    // 5. Check 'CHICAGO' or 'UNION'
    const union = db.prepare("SELECT * FROM schedules WHERE stop_id LIKE '%UNION%' OR stop_id LIKE '%CUS%' LIMIT 5").all();
    console.log(`Stops like UNION/CUS:`, union.map((u: any) => u.stop_id));

} catch (e: any) {
    console.error("DB Error:", e.message);
}

// 6. Check Shape Logic
console.log('\n--- Shape Logic Check ---');
const shapesPath = path.resolve(process.cwd(), "server/gtfs/data/shapes.txt");
if (fs.existsSync(shapesPath)) {
    const data = fs.readFileSync(shapesPath, 'utf8');
    const lines = data.split('\n');
    let mdwPoints = 0;
    lines.forEach(line => {
        if (line.includes('MD-W_IB')) mdwPoints++;
    });
    console.log(`Found ${mdwPoints} points for MD-W_IB in shapes.txt`);
} else {
    console.log('shapes.txt not found at expected path');
}
