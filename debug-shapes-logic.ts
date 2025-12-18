
import fs from 'fs';
import path from 'path';

const shapesPath = path.resolve('./server/gtfs/data/shapes.txt');
const shapesData = fs.readFileSync(shapesPath, "utf-8");
const lines = shapesData.split("\n");

const lineId = 'MD-W'; // Testing MD-W
const inboundPoints: Array<[number, number]> = [];
const outboundPoints: Array<[number, number]> = [];

// Shape IDs in GTFS: UP-NW_IB_1, MD-W_IB_1, etc.
const ibShapeId = `${lineId}_IB_1`;
const obShapeId = `${lineId}_OB_1`;

console.log(`Searching for shapes: ${ibShapeId}, ${obShapeId}`);

for (let i = 1; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;
  
  const [shape_id, lat_str, lng_str] = line.split(",");
  
  if (shape_id === ibShapeId || (lineId === 'MD-W' && shape_id.startsWith('MD-W_IB'))) {
    const lat = parseFloat(lat_str);
    const lng = parseFloat(lng_str);
    if (!isNaN(lat) && !isNaN(lng)) {
      inboundPoints.push([lat, lng]);
    }
  } else if (shape_id === obShapeId || (lineId === 'MD-W' && shape_id.startsWith('MD-W_OB'))) {
    const lat = parseFloat(lat_str);
    const lng = parseFloat(lng_str);
    if (!isNaN(lat) && !isNaN(lng)) {
      outboundPoints.push([lat, lng]);
    }
  }
}

console.log(`Found ${inboundPoints.length} inbound points`);
console.log(`Found ${outboundPoints.length} outbound points`);
console.log('Sample Inbound:', inboundPoints.slice(0, 3));
