
import fs from 'fs';
import path from 'path';

const shapesPath = path.resolve('./server/gtfs/data/shapes.txt');
const shapesData = fs.readFileSync(shapesPath, "utf-8");
const lines = shapesData.split("\n");

const shapeCounts: Record<string, number> = {};

for (let i = 1; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;
  
  const [shape_id] = line.split(",");
  if (shape_id.includes('MD-W')) {
    shapeCounts[shape_id] = (shapeCounts[shape_id] || 0) + 1;
  }
}

console.log('MD-W Shape IDs:', JSON.stringify(shapeCounts, null, 2));
