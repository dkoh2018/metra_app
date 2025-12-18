export interface Station {
  lat: number;
  lng: number;
  name: string;
  isTerminal?: boolean;
  isBranch?: boolean;
  isHighlight?: boolean;
  gtfsId?: string;
  line: 'UP-NW' | 'MD-W';
  terminal: 'OTC' | 'CUS';
}

export const STATIONS: Record<string, Station> = {
  harvard: { lat: 42.4197222, lng: -88.6175000, name: 'Harvard', isTerminal: true, gtfsId: 'HARVARD', line: 'UP-NW', terminal: 'OTC' },
  woodstock: { lat: 42.3169444, lng: -88.4475000, name: 'Woodstock', gtfsId: 'WOODSTOCK', line: 'UP-NW', terminal: 'OTC' },
  crystal: { lat: 42.2442, lng: -88.3172, name: 'Crystal Lake', gtfsId: 'CRYSTAL', line: 'UP-NW', terminal: 'OTC' },
  pingree: { lat: 42.2341667, lng: -88.2980556, name: 'Pingree Road', gtfsId: 'PINGREE', line: 'UP-NW', terminal: 'OTC' },
  cary: { lat: 42.2088889, lng: -88.2413889, name: 'Cary', gtfsId: 'CARY', line: 'UP-NW', terminal: 'OTC' },
  foxRiverGrove: { lat: 42.1977778, lng: -88.2194444, name: 'Fox River Grove', gtfsId: 'FOXRG', line: 'UP-NW', terminal: 'OTC' },
  barrington: { lat: 42.1527778, lng: -88.1319444, name: 'Barrington', gtfsId: 'BARRINGTON', line: 'UP-NW', terminal: 'OTC' },
  palatine: { lat: 42.1130556, lng: -88.0483333, name: 'Palatine', isHighlight: true, gtfsId: 'PALATINE', line: 'UP-NW', terminal: 'OTC' },
  arlingtonPark: { lat: 42.0952778, lng: -88.0091667, name: 'Arlington Park', gtfsId: 'ARLINGTNPK', line: 'UP-NW', terminal: 'OTC' },
  arlingtonHeights: { lat: 42.0841667, lng: -87.9836111, name: 'Arlington Heights', gtfsId: 'ARLINGTNHT', line: 'UP-NW', terminal: 'OTC' },
  mtProspect: { lat: 42.0630556, lng: -87.9361111, name: 'Mt. Prospect', gtfsId: 'MTPROSPECT', line: 'UP-NW', terminal: 'OTC' },
  cumberland: { lat: 42.0525000, lng: -87.9122222, name: 'Cumberland', gtfsId: 'CUMBERLAND', line: 'UP-NW', terminal: 'OTC' },
  desPlaines: { lat: 42.0408333, lng: -87.8866667, name: 'Des Plaines', gtfsId: 'DESPLAINES', line: 'UP-NW', terminal: 'OTC' },
  deeRoad: { lat: 42.0241667, lng: -87.8561111, name: 'Dee Road', gtfsId: 'DEEROAD', line: 'UP-NW', terminal: 'OTC' },
  parkRidge: { lat: 42.0102778, lng: -87.8316667, name: 'Park Ridge', gtfsId: 'PARKRIDGE', line: 'UP-NW', terminal: 'OTC' },
  edisonPark: { lat: 42.0022222, lng: -87.8175000, name: 'Edison Park', gtfsId: 'EDISONPK', line: 'UP-NW', terminal: 'OTC' },
  norwoodPark: { lat: 41.9916667, lng: -87.7988889, name: 'Norwood Park', gtfsId: 'NORWOODP', line: 'UP-NW', terminal: 'OTC' },
  gladstonePark: { lat: 41.9797222, lng: -87.7780556, name: 'Gladstone Park', gtfsId: 'GLADSTONEP', line: 'UP-NW', terminal: 'OTC' },
  jeffersonPark: { lat: 41.9713889, lng: -87.7633333, name: 'Jefferson Park', gtfsId: 'JEFFERSONP', line: 'UP-NW', terminal: 'OTC' },
  irvingPark: { lat: 41.9525000, lng: -87.7297222, name: 'Irving Park', gtfsId: 'IRVINGPK', line: 'UP-NW', terminal: 'OTC' },
  clybourn: { lat: 41.9169444, lng: -87.6680556, name: 'Clybourn', gtfsId: 'CLYBOURN', line: 'UP-NW', terminal: 'OTC' },
  ogilvie: { lat: 41.8822222, lng: -87.6405556, name: 'Ogilvie Transportation Center', isTerminal: true, gtfsId: 'OTC', line: 'UP-NW', terminal: 'OTC' },
  
  // MD-W Line (Milwaukee District West) - Coordinates snapped to rail line
  bigTimber: { lat: 42.0586936, lng: -88.3282646, name: 'Big Timber', isTerminal: true, gtfsId: 'BIGTIMBER', line: 'MD-W', terminal: 'CUS' },
  elgin: { lat: 42.0361111, lng: -88.2861111, name: 'Elgin', gtfsId: 'ELGIN', line: 'MD-W', terminal: 'CUS' },
  nationalStreet: { lat: 42.0288783, lng: -88.2798941, name: 'National Street', gtfsId: 'NATIONALS', line: 'MD-W', terminal: 'CUS' },
  bartlett: { lat: 41.9920463, lng: -88.1823563, name: 'Bartlett', gtfsId: 'BARTLETT', line: 'MD-W', terminal: 'CUS' },
  hanoverPark: { lat: 41.9881015, lng: -88.1490052, name: 'Hanover Park', gtfsId: 'HANOVERP', line: 'MD-W', terminal: 'CUS' },
  schaumburg: { lat: 41.9892520, lng: -88.1180587, name: 'Schaumburg', isHighlight: true, gtfsId: 'SCHAUM', line: 'MD-W', terminal: 'CUS' },
  roselle: { lat: 41.9814724, lng: -88.0670396, name: 'Roselle', gtfsId: 'ROSELLE', line: 'MD-W', terminal: 'CUS' },
  medinah: { lat: 41.9780996, lng: -88.0501419, name: 'Medinah', gtfsId: 'MEDINAH', line: 'MD-W', terminal: 'CUS' },
  itasca: { lat: 41.9716674, lng: -88.0146190, name: 'Itasca', gtfsId: 'ITASCA', line: 'MD-W', terminal: 'CUS' },
  woodDale: { lat: 41.9626553, lng: -87.9756340, name: 'Wood Dale', gtfsId: 'WOODDALE', line: 'MD-W', terminal: 'CUS' },
  bensenville: { lat: 41.9566667, lng: -87.9419444, name: 'Bensenville', gtfsId: 'BENSENVIL', line: 'MD-W', terminal: 'CUS' },
  mannheim: { lat: 41.9403896, lng: -87.8798467, name: 'Mannheim', gtfsId: 'MANNHEIM', line: 'MD-W', terminal: 'CUS' },
  franklinPark: { lat: 41.9363999, lng: -87.8661672, name: 'Franklin Park', gtfsId: 'FRANKLIN', line: 'MD-W', terminal: 'CUS' },
  riverGrove: { lat: 41.9306218, lng: -87.8352564, name: 'River Grove', gtfsId: 'RIVERGROVE', line: 'MD-W', terminal: 'CUS' },
  elmwoodPark: { lat: 41.9247353, lng: -87.8141321, name: 'Elmwood Park', gtfsId: 'ELMWOODPK', line: 'MD-W', terminal: 'CUS' },
  montClare: { lat: 41.9212106, lng: -87.7998110, name: 'Mont Clare', gtfsId: 'MONTCLARE', line: 'MD-W', terminal: 'CUS' },
  mars: { lat: 41.9186127, lng: -87.7927140, name: 'Mars', gtfsId: 'MARS', line: 'MD-W', terminal: 'CUS' },
  galewood: { lat: 41.9164368, lng: -87.7857632, name: 'Galewood', gtfsId: 'GALEWOOD', line: 'MD-W', terminal: 'CUS' },
  hansonPark: { lat: 41.9166810, lng: -87.7669077, name: 'Hanson Park', gtfsId: 'HANSONPK', line: 'MD-W', terminal: 'CUS' },
  grandCicero: { lat: 41.9144329, lng: -87.7458759, name: 'Grand/Cicero', gtfsId: 'GRAND-CIC', line: 'MD-W', terminal: 'CUS' },
  westernAve: { lat: 41.8891760, lng: -87.6887407, name: 'Western Ave', gtfsId: 'WESTERNAVE', line: 'MD-W', terminal: 'CUS' },
  unionStation: { lat: 41.8787915, lng: -87.6389813, name: 'Chicago Union Station', isTerminal: true, gtfsId: 'CUS', line: 'MD-W', terminal: 'CUS' },
};
