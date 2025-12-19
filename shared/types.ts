export type LineId = 'UP-NW' | 'MD-W';

export type CrowdingLevel = 'low' | 'some' | 'moderate' | 'high';

export interface Station {
  lat: number;
  lng: number;
  name: string;
  isTerminal?: boolean;
  isBranch?: boolean;
  isHighlight?: boolean;
  gtfsId?: string;
  line: LineId;
  terminal: 'OTC' | 'CUS';
}

export interface Train {
  id: string; // train number or trip id
  departureTime: string; // HH:mm
  arrivalTime: string; // HH:mm
  isExpress: boolean;
  _tripId?: string; // Optional internal GTFS trip ID
}

// For server-side compatibility where database columns use snake_case
// We extend the base Train but might need a separate interface or adapter if they diverge too much.
// For now, let's keep a unified interface that prefers camelCase for the app,
// but acknowledge server might return snake_case.
// Actually, to fully modularize, let's define the ServerTrainSchedule separately here if we want strictly shared types,
// OR we update the server to return normalized data.
// Given strict typescript, let's define the precise shape used in the DB/API if strictly needed,
// but simpler is to just define what the *Application* uses.
// The Plan said "Define Train interface (unifying client and server definitions)".
// The server `TrainSchedule` has snake_case. The client `Train` has camelCase.
// Let's export both or a union if they are distinct.

export interface ServerTrainSchedule {
  trip_id: string;
  departure_time: string;
  arrival_time: string;
  is_express: boolean;
}
