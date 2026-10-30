// What the dashboard's connection tiles report. `live: false` shows amber.

export function floorPlanStatus(config) {
  return config.example
    ? { live: false, value: 'Example', detail: `Invented tables, not ${config.venueName ?? config.venue}'s floor plan` }
    : { live: true, value: 'Configured', detail: `${Object.keys(config.tables).length} tables` };
}
