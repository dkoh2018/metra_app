
function parseTimeToMinutes(timeStr) {
  if (!timeStr) return -1;
  
  if (timeStr.toLowerCase().includes('m')) {
    const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)/i);
    if (!match) return -1;
    
    let [_, hoursStr, minsStr, meridian] = match;
    let hours = parseInt(hoursStr);
    const mins = parseInt(minsStr);
    
    if (meridian.toUpperCase() === 'PM' && hours !== 12) hours += 12;
    if (meridian.toUpperCase() === 'AM' && hours === 12) hours = 0;
    
    return hours * 60 + mins;
  }
  
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function calculateDuration(departureTime, arrivalTime) {
  if (!departureTime || !arrivalTime) return 0;
  
  const parse = (t) => {
    if (t.toLowerCase().includes('m')) {
      return parseTimeToMinutes(t);
    }
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };

  const dep = parse(departureTime);
  const arr = parse(arrivalTime);
  
  let duration = arr - dep;
  if (duration < 0) duration += 24 * 60; 
  
  return duration;
}

console.log("Test 1 (AM/PM):", calculateDuration("11:12 PM", "12:10 AM"));
console.log("Test 6 (ISO parsing bug):");
const isoStr = "2025-12-18T23:52:00";
// Simulate formatPredictedTimeDisplay logic
const [hStr, mStr] = isoStr.split(':');
const h = parseInt(hStr); // 2025
const m = parseInt(mStr); // 52
const ampm = h >= 12 ? 'PM' : 'AM';
const h12 = h % 12 || 12; // 2025 % 12 = 9
const formatted = `${h12}:${m.toString().padStart(2, '0')} ${ampm}`; // "9:52 PM"
console.log(`Parsed "${isoStr}" as "${formatted}"`);
console.log("Duration 11:14 PM -> 9:52 PM:", calculateDuration("11:14 PM", formatted));
