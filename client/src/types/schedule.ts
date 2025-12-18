
export type DayType = 'weekday' | 'saturday' | 'sunday';
export type Direction = 'inbound' | 'outbound';
export type CrowdingLevel = 'low' | 'some' | 'moderate' | 'high';

// API response types
export interface ApiTrain {
  trip_id: string;
  departure_time: string;
  arrival_time: string;
  is_express: boolean | number;
}

export interface ApiSchedule {
  type: DayType;
  inbound: ApiTrain[];
  outbound: ApiTrain[];
}

export interface ApiAlerts {
  id: string;
  alert?: {
    activePeriod?: Array<{ start?: string; end?: string }>;
    informedEntity?: Array<{ routeId?: string }>;
    headerText?: { translation?: Array<{ text?: string }> };
    descriptionText?: { translation?: Array<{ text?: string }> };
  };
  // Some feeds might have flat structure depending on GTFS bindings
  routeId?: string;
  headerText?: { translation?: Array<{ text?: string }> };
  descriptionText?: { translation?: Array<{ text?: string }> };
  translation?: Array<{ text?: string }>;
  text?: string;
}
