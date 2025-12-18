export interface Station {
  lat: number;
  lng: number;
  name: string;
  isTerminal?: boolean;
  isBranch?: boolean;
  isHighlight?: boolean;
  gtfsId?: string;
}

export const STATIONS: Record<string, Station> = {
  /* Restricting to Palatine only as per user request
  harvard: { lat: 42.4197222, lng: -88.6175000, name: 'Harvard', isTerminal: true, gtfsId: 'HARVARD' },
  woodstock: { lat: 42.3169444, lng: -88.4475000, name: 'Woodstock', gtfsId: 'WOODSTOCK' },
  // McHenry removed as per user request
  crystal: { lat: 42.2441667, lng: -88.3172222, name: 'Crystal Lake', gtfsId: 'CRYSTAL' },
  pingree: { lat: 42.2341667, lng: -88.2980556, name: 'Pingree Road', gtfsId: 'PINGREE' },
  cary: { lat: 42.2088889, lng: -88.2413889, name: 'Cary', gtfsId: 'CARY' },
  foxRiverGrove: { lat: 42.1977778, lng: -88.2194444, name: 'Fox River Grove', gtfsId: 'FOXRG' },
  barrington: { lat: 42.1527778, lng: -88.1319444, name: 'Barrington', gtfsId: 'BARRINGTON' },
  */
  palatine: { lat: 42.1130556, lng: -88.0483333, name: 'Palatine', isHighlight: true, gtfsId: 'PALATINE' },
  /*
  arlingtonPark: { lat: 42.0952778, lng: -88.0091667, name: 'Arlington Park', gtfsId: 'ARLINGTNPK' },
  arlingtonHeights: { lat: 42.0841667, lng: -87.9836111, name: 'Arlington Heights', gtfsId: 'ARLINGTNHT' },
  mtProspect: { lat: 42.0630556, lng: -87.9361111, name: 'Mt. Prospect', gtfsId: 'MTPROSPECT' },
  cumberland: { lat: 42.0525000, lng: -87.9122222, name: 'Cumberland', gtfsId: 'CUMBERLAND' },
  desPlaines: { lat: 42.0408333, lng: -87.8866667, name: 'Des Plaines', gtfsId: 'DESPLAINES' },
  deeRoad: { lat: 42.0241667, lng: -87.8561111, name: 'Dee Road', gtfsId: 'DEEROAD' },
  parkRidge: { lat: 42.0102778, lng: -87.8316667, name: 'Park Ridge', gtfsId: 'PARKRIDGE' },
  edisonPark: { lat: 42.0022222, lng: -87.8175000, name: 'Edison Park', gtfsId: 'EDISONPK' },
  norwoodPark: { lat: 41.9916667, lng: -87.7988889, name: 'Norwood Park', gtfsId: 'NORWOODP' },
  gladstonePark: { lat: 41.9797222, lng: -87.7780556, name: 'Gladstone Park', gtfsId: 'GLADSTONEP' },
  jeffersonPark: { lat: 41.9713889, lng: -87.7633333, name: 'Jefferson Park', gtfsId: 'JEFFERSONP' },
  irvingPark: { lat: 41.9525000, lng: -87.7297222, name: 'Irving Park', gtfsId: 'IRVINGPK' },
  clybourn: { lat: 41.9169444, lng: -87.6680556, name: 'Clybourn', gtfsId: 'CLYBOURN' },
  */
  ogilvie: { lat: 41.8822222, lng: -87.6405556, name: 'Ogilvie Transportation Center', isTerminal: true, gtfsId: 'OTC' },
};
