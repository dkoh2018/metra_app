
// Custom dark-themed colors for the 5 supported train lines
// Palette: Black, Blue, Green as requested

export const LINE_COLORS: Record<string, string> = {
  // UP-NW: Dark Slate (Black-ish)
  'UP-NW': '#0f172a', 
  
  // MD-W: Cyan/Teal (Blue-Green)
  'MD-W': '#06b6d4',
  
  // UP-N: Forest Green (Dark Green)
  'UP-N': '#15803d',
  
  // BNSF: Emerald (Bright Green)
  'BNSF': '#10b981',
  
  // UP-W: Midnight Blue (Dark Blue)
  'UP-W': '#1e3a8a',
  
  // Fallback
  'default': '#334155'
};
