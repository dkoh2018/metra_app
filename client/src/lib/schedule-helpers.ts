
import { ApiTrain, CrowdingLevel } from '../types/schedule';
import { parseTimeToMinutes } from './time-utils';
import { Train } from './scheduleData';

// Cache compiled regex patterns for better performance
// Supports UP-NW (UNW), UP-N (UN), MD-W (MW), BNSF (BN), and UP-W (UW) IDs
// Made case-insensitive to be safe
export const TRIP_ID_REGEX = /(?:UNW|UN|MW|BN|UW)(\d+)/i;
export const TIME_PATTERN_REGEX = /(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)/gi;
export const MINUTES_PATTERN_REGEX = /(\d+)\s*min/;

export const CROWDING_DOT_STYLES: Record<CrowdingLevel, string> = {
  low: "bg-green-600",
  some: "bg-amber-500",
  moderate: "bg-orange-500",
  high: "bg-red-700"
};

export const CROWDING_LABELS: Record<CrowdingLevel, string> = {
  low: "Low",
  some: "Some",
  moderate: "Moderate",
  high: "High"
};

// Reusable helper to extract train number from a Trip ID
// Handles standard (UP-NW_UN608...), legacy, and simplified/naked (UP-N_345...) formats
export function extractTrainIdFromTripId(tripId: string): string {
  if (!tripId) return "Unknown";
  
  let trainId = "Unknown";
  
  // Strategy 0: Direct Regex Match (Looking for UN608, MW2200, UW500, BN1200)
  const match = tripId.match(TRIP_ID_REGEX);
  if (match && match[1]) {
    return match[1];
  }
  
  // Fallback: split by _ and try to find the part with digits
  const parts = tripId.split('_');
  
  // Strategy 1: Look for Prefixed Pattern (UNW608, MW2200, etc) inside parts
  // Example: UP-NW_UNW608_V1_A -> "UNW608"
  let numberPart = parts.find(p => /\d+/.test(p) && (
    p.toUpperCase().includes('UNW') || 
    p.toUpperCase().includes('MW') || 
    p.toUpperCase().includes('UN') || 
    p.toUpperCase().includes('BN') || 
    p.toUpperCase().includes('UW')
  ));
  
  // Strategy 2: Look for Naked Number Pattern (345, 516, 2200) if no prefix found
  // Must be 3-4 digits. This handles cases like "UP-N_345_V1_A" where prefix is missing.
  if (!numberPart) {
    numberPart = parts.find(p => /^\d{3,4}$/.test(p));
  }

  if (numberPart) {
    trainId = numberPart.toUpperCase()
      .replace('UNW', '')
      .replace('MW', '')
      .replace('UN', '')
      .replace('BN', '')
      .replace('UW', '');
  }
  
  return trainId;
}

// Transform API train to frontend Train format
export function transformTrain(apiTrain: ApiTrain, tripIdMap: Map<string, string>): Train {
  // Extract train number from trip_id using centralized logic
  const trainId = extractTrainIdFromTripId(apiTrain.trip_id);

  // Populate map for reverse lookup (Train # -> Trip ID)
  if (trainId !== "Unknown") {
    tripIdMap.set(trainId, apiTrain.trip_id);
  }

  return {
    id: trainId,
    departureTime: apiTrain.departure_time,
    arrivalTime: apiTrain.arrival_time,
    isExpress: !!apiTrain.is_express,
    // Add original trip_id for debugging/matching
    _tripId: apiTrain.trip_id 
  };
}

// Helper to convert departure time to minutes for comparison (handles overnight trains)
// Uses centralized overnight-utils for edge case handling
import { getAdjustedTrainMinutes } from './overnight-utils';

export function getTrainMinutesForComparison(departureTimeStr: string, currentMinutesValue: number): number {
  if (!departureTimeStr) return 9999;
  
  // Parse the time string to minutes
  let mins = parseTimeToMinutes(departureTimeStr);
  
  // Handle GTFS > 24h times - keep as-is for overnight-utils to handle
  const parts = departureTimeStr.split(':');
  if (parseInt(parts[0]) >= 24) {
    // For GTFS overnight format, return adjusted value
    return getAdjustedTrainMinutes(mins, currentMinutesValue);
  }
  
  // Use centralized overnight handling
  return getAdjustedTrainMinutes(mins, currentMinutesValue);
}
