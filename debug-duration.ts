
import { calculateDuration } from './client/src/lib/time-utils';

console.log("--- Debugging Duration Calculation ---");

const depCST = "15:12";
const arrUTC = "21:09"; // 3:09 PM CST is 21:09 UTC

const duration = calculateDuration(depCST, arrUTC);
console.log(`Dep: ${depCST}, Arr: ${arrUTC} (UTC-like)`);
console.log(`Calculated Duration: ${duration} minutes`);

if (duration === 357) {
    console.log("MATCH! 357m reproduced.");
} else {
    console.log(`No match (expected 357, got ${duration})`);
}

// Check ISO parsing behavior
const iso = "2025-12-18T21:09:00Z";
console.log("\nISO String Test:");
const durIso = calculateDuration(depCST, iso);
console.log(`Dep: ${depCST}, Arr: ${iso}`);
console.log(`Calculated Duration: ${durIso} minutes`);

// Check logic breakdown
const [h, m] = iso.split(':').map(Number); // Logic in calculateDuration -> parse
console.log(`ISO split parsed as h=${h}, m=${m}`);
