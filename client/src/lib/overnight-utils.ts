/**
 * Overnight Time Utilities
 * 
 * GTFS uses 24-hour+ format for overnight trains (e.g., 24:35 = 12:35 AM next day, 25:15 = 1:15 AM).
 * These utilities handle the edge cases when viewing schedules around midnight.
 * 
 * Key scenarios:
 * 1. Viewing LATE at night (after 6 PM), checking EARLY morning trains (before 4 AM)
 *    → These trains are "tonight's late" trains, happening soon
 * 
 * 2. Viewing EARLY morning (before 4 AM), checking EVENING trains (after 6 PM)
 *    → These trains already departed yesterday, should be marked as "Gone"
 * 
 * 3. GTFS 24:XX+ times viewed after midnight
 *    → Normalize by subtracting 24 hours (1440 minutes)
 */

// Time thresholds (in minutes from midnight)
export const OVERNIGHT_CONFIG = {
  EARLY_MORNING_CUTOFF: 4 * 60,   // 4 AM = 240 minutes
  EVENING_START: 18 * 60,          // 6 PM = 1080 minutes
  LATE_NIGHT_START: 20 * 60,       // 8 PM = 1200 minutes
  SERVICE_DAY_START: 60,           // 1 AM = 60 minutes (Metra service day boundary)
  OVERNIGHT_CUTOFF: 60,            // 1 AM boundary
  MAX_REASONABLE_WAIT: 26 * 60,    // 26 hours - increased to allow 1AM -> 11PM same-day lookahead
  MINUTES_PER_DAY: 24 * 60,        // 1440 minutes
};

/**
 * Check if current viewing time is in early morning (before 4 AM)
 */
export function isEarlyMorning(currentMinutes: number): boolean {
  return currentMinutes < OVERNIGHT_CONFIG.EARLY_MORNING_CUTOFF;
}

/**
 * Check if current viewing time is late at night (after 8 PM)
 */
export function isLateNight(currentMinutes: number): boolean {
  return currentMinutes >= OVERNIGHT_CONFIG.LATE_NIGHT_START;
}

/**
 * Check if a train time is in the evening (6 PM - midnight)
 */
export function isEveningTrain(trainMinutes: number): boolean {
  return trainMinutes >= OVERNIGHT_CONFIG.EVENING_START && trainMinutes < OVERNIGHT_CONFIG.MINUTES_PER_DAY;
}

/**
 * Check if a train time is in early morning (midnight - 4 AM)
 */
export function isEarlyMorningTrain(trainMinutes: number): boolean {
  return trainMinutes < OVERNIGHT_CONFIG.EARLY_MORNING_CUTOFF;
}

/**
 * Check if a GTFS time is in overnight format (24:XX or 25:XX)
 */
export function isGtfsOvernightTime(trainMinutes: number): boolean {
  return trainMinutes >= OVERNIGHT_CONFIG.MINUTES_PER_DAY;
}

/**
 * Normalize a GTFS overnight time to regular minutes
 * Example: 24:35 (1475 min) → 00:35 (35 min)
 */
export function normalizeGtfsOvernightTime(trainMinutes: number): number {
  if (trainMinutes >= OVERNIGHT_CONFIG.MINUTES_PER_DAY) {
    return trainMinutes - OVERNIGHT_CONFIG.MINUTES_PER_DAY;
  }
  return trainMinutes;
}

/**
 * Determine if a train has departed based on current time
 * Handles overnight edge cases
 */
export function hasTrainDeparted(trainMinutes: number, currentMinutes: number): boolean {
  // GTFS 24:XX times in early morning are still upcoming
  if (isGtfsOvernightTime(trainMinutes)) {
    if (isEarlyMorning(currentMinutes)) {
      const normalizedTrain = normalizeGtfsOvernightTime(trainMinutes);
      return normalizedTrain < currentMinutes;
    }
    // If not early morning and train is 24:XX, it's in the future
    return false;
  }
  
  // Early morning viewing, evening train → REMOVED (Viewing 'Today's' schedule means these are future)
  /* if (isEarlyMorning(currentMinutes) && isEveningTrain(trainMinutes)) {
    return true; 
  } */
  
  // Late night viewing, early morning train → these are upcoming "tonight" trains
  if (isLateNight(currentMinutes) && isEarlyMorningTrain(trainMinutes)) {
    return false;
  }
  
  // Standard comparison
  return trainMinutes < currentMinutes;
}

/**
 * Calculate minutes until a train departs, handling overnight edge cases
 * Returns null if train has departed or calculation is unreasonable
 */
export function getMinutesUntilTrain(trainMinutes: number, currentMinutes: number): number | null {
  // Train departed yesterday
  if (trainMinutes === -1) {
    return null;
  }
  
  // GTFS 24:XX times when viewing early morning - normalize
  if (isGtfsOvernightTime(trainMinutes) && isEarlyMorning(currentMinutes)) {
    const normalizedTrain = normalizeGtfsOvernightTime(trainMinutes);
    const minutesUntil = normalizedTrain - currentMinutes;
    if (minutesUntil < 0) return null; // Already departed
    return minutesUntil;
  }
  
  // Early morning viewing, evening train → REMOVED (Viewing 'Today's' schedule means these are future)
  /* if (isEarlyMorning(currentMinutes) && isEveningTrain(trainMinutes)) {
    return null;
  } */
  
  // Late night viewing, early morning train → add 24 hours for proper calculation
  if (isLateNight(currentMinutes) && isEarlyMorningTrain(trainMinutes)) {
    const adjustedTrain = trainMinutes + OVERNIGHT_CONFIG.MINUTES_PER_DAY;
    return adjustedTrain - currentMinutes;
  }
  
  let minutesUntil = trainMinutes - currentMinutes;
  
  // Recently departed (within last hour)
  if (minutesUntil < 0 && minutesUntil > -60) {
    return null;
  }
  
  // Very negative - might need to add a day
  if (minutesUntil < -60) {
    minutesUntil += OVERNIGHT_CONFIG.MINUTES_PER_DAY;
  }
  
  // Unreasonably long wait - probably stale data
  if (minutesUntil > OVERNIGHT_CONFIG.MAX_REASONABLE_WAIT) {
    return null;
  }
  
  return minutesUntil > 0 ? minutesUntil : null;
}

/**
 * Adjust train minutes for comparison/sorting
 * Returns -1 if train should be skipped (departed yesterday)
 */
export function getAdjustedTrainMinutes(trainMinutes: number, currentMinutes: number): number {
  // GTFS 24:XX times
  if (isGtfsOvernightTime(trainMinutes)) {
    if (isEarlyMorning(currentMinutes)) {
      return normalizeGtfsOvernightTime(trainMinutes);
    }
    // Late night - keep as-is (future train)
    return trainMinutes;
  }
  
  // Late night viewing, early morning train → add 24h for proper sorting
  if (isLateNight(currentMinutes) && isEarlyMorningTrain(trainMinutes)) {
    return trainMinutes + OVERNIGHT_CONFIG.MINUTES_PER_DAY;
  }
  
  return trainMinutes;
}
