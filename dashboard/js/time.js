let selectedTimezone = 'local';

export function setTimezone(value) {
  selectedTimezone = value || 'local';
}

export function localTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function activeTimezone() {
  return selectedTimezone === 'local' ? localTimezone() : selectedTimezone;
}

export function formatTime(timestamp, includeZone = false) {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: activeTimezone(),
    timeZoneName: includeZone ? 'short' : undefined,
  }).format(new Date(timestamp));
}
