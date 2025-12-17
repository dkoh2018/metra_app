
import { loadGTFSIntoDatabase } from '../server/db/gtfs-loader';

async function reload() {
  console.log('Starting GTFS reload...');
  try {
    await loadGTFSIntoDatabase();
    console.log('GTFS reload complete.');
  } catch (error) {
    console.error('GTFS reload failed:', error);
  }
}

reload();
