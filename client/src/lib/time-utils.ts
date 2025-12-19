
// Helper function to parse time string to minutes (handles both "8:13 PM" and "19:13" formats)
export function parseTimeToMinutes(timeStr: string): number {
  if (!timeStr) return -1;
  
  // Handle "HH:MM AM/PM" format (supports a.m./p.m.)
  if (timeStr.toLowerCase().includes('m')) {
    const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM|am|pm|a\.m\.|p\.m\.)/i);
    if (!match) return -1;
    
    let [_, hoursStr, minsStr, meridian] = match;
    let hours = parseInt(hoursStr);
    const mins = parseInt(minsStr);
    
    // Normalize meridian
    const isPM = meridian.toLowerCase().startsWith('p');
    const isAM = meridian.toLowerCase().startsWith('a');
    
    if (isPM && hours !== 12) hours += 12;
    if (isAM && hours === 12) hours = 0;
    
    return hours * 60 + mins;
  }
  
  // Handle "HH:MM" (24h) format
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

export function formatPredictedTimeDisplay(timeStr?: string | null): string | null {
  if (!timeStr) return null;
  // If it already has AM/PM, return as is
  if (timeStr.toLowerCase().includes('m')) return timeStr;
  
  // Handle ISO string (e.g. 2025-12-18T23:52:00)
  if (timeStr.includes('T')) {
    const date = new Date(timeStr);
    if (!isNaN(date.getTime())) {
      let h = date.getHours();
      const m = date.getMinutes();
      const ampm = h >= 12 ? 'PM' : 'AM';
      const h12 = h % 12 || 12;
      return `${h12}:${m.toString().padStart(2, '0')} ${ampm}`;
    }
  }
  
  // Otherwise assume HH:MM:SS or HH:MM and convert to 12h
  const [hStr, mStr] = timeStr.split(':');
  const h = parseInt(hStr);
  const m = parseInt(mStr);
  
  if (isNaN(h) || isNaN(m)) return timeStr;
  
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${m.toString().padStart(2, '0')} ${ampm}`;
}

// Calculate trip duration in minutes
export function calculateDuration(departureTime: string, arrivalTime: string): number {
  if (!departureTime || !arrivalTime) return 0;
  
  const parse = (t: string) => {
    // Check for "HH:MM AM/PM" format
    if (t.toLowerCase().includes('m')) {
      return parseTimeToMinutes(t);
    }
    // Check for "HH:MM:SS" or "HH:MM" 24h format
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };

  const dep = parse(departureTime);
  const arr = parse(arrivalTime);
  
  let duration = arr - dep;
  if (duration < 0) duration += 24 * 60; // Handle overnight trips
  
  return duration;
}

export function getChicagoMinutesFromTimeString(timeStr?: string | null): number | null {
  if (!timeStr) return null;
  
  // Case 1: ISO String (2025-12-18T16:02:50.705Z)
  if (timeStr.includes('T') && timeStr.includes('Z')) {
    const date = new Date(timeStr);
    if (isNaN(date.getTime())) return null;
    
    // Convert directly to Chicago timestamp
    const chicagoDateStr = date.toLocaleString('en-US', { timeZone: 'America/Chicago' });
    const chicagoDate = new Date(chicagoDateStr);
    
    return chicagoDate.getHours() * 60 + chicagoDate.getMinutes();
  }
  
  // Case 2: "HH:MM:SS" or "HH:MM"
  if (timeStr.includes(':')) {
    // If it has AM/PM, use our parser
    if (timeStr.toLowerCase().includes('m')) {
      return parseTimeToMinutes(timeStr);
    }
    
    const [h, m] = timeStr.split(':').map(Number);
    if (!isNaN(h) && !isNaN(m)) {
      return h * 60 + m;
    }
  }
  
  return null;
}

export function isPredictedTimeReasonable(
  predicted?: string | null,
  scheduled?: string | null,
  fallbackScheduleTime?: string
): boolean {
  if (!predicted) return false;
  
  const predMins = parseTimeToMinutes(predicted);
  // Use scheduled time if available, otherwise fallback (e.g. from static schedule)
  const schedMins = scheduled ? parseTimeToMinutes(scheduled) : (fallbackScheduleTime ? parseTimeToMinutes(fallbackScheduleTime) : -1);
  
  if (predMins === -1 || schedMins === -1) return false;
  
  // Difference in minutes
  let diff = predMins - schedMins;
  
  // Prepare for overnight wrap-around (e.g. scheduled 11:50 PM, predicted 12:10 AM)
  if (diff < -1000) diff += 1440; // Predicted is next day
  if (diff > 1000) diff -= 1440;  // Precdicted is prev day (unlikely but possible)
  
  // Reasonable if within -10 mins (early) to +120 mins (late)
  // If it's > 2 hours late, it's probably a data glitch (tomorrow's train?) or a major service disruption
  // But usually Metra doesn't predict > 2 hours late accurately.
  // HOWEVER: We want to show delays even if massive.
  // The main check is: is it completely separate train?
  // Let's allow up to 4 hours variance.
  return diff > -20 && diff < 240; 
}
