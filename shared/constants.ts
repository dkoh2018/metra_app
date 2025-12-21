import { LineId } from './types';

export const SUPPORTED_LINES: LineId[] = ['UP-NW', 'MD-W', 'UP-N', 'BNSF', 'UP-W'];

export const DEFAULT_LINE: LineId = 'UP-NW';

export const LINE_NAMES: Record<LineId, string> = {
  'UP-NW': 'Union Pacific Northwest',
  'MD-W': 'Milwaukee District West',
  'UP-N': 'Union Pacific North',
  'BNSF': 'Burlington Northern Santa Fe',
  'UP-W': 'Union Pacific West'
};
