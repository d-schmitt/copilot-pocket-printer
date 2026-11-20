export function dailyFixture(bottom = 'joke') {
  const stamp = time => `2026-11-17T${time}:00+01:00`;
  return {
    version: 1, layout: 'daily-card',
    config: { location: 'Friedrichshafen', latitude: 47.65, longitude: 9.48, timezone: 'Europe/Berlin',
      work_start: '08:00', work_end: '17:00', lunch_start: '12:00', lunch_end: '13:00' },
    date: '2026-11-17', now: stamp('06:00'),
    calendar: { state: 'available', events: [
      { start: stamp('09:00'), end: stamp('09:30') },
      { start: stamp('12:00'), end: stamp('12:30') },
      { start: stamp('15:00'), end: stamp('15:30') }
    ] },
    weather: { state: 'available', sunrise: stamp('07:30'), sunset: stamp('17:00'),
      hours: Array.from({ length: 24 }, (_, hour) => ({
        start: stamp(`${String(hour).padStart(2, '0')}:00`), cloud: hour === 12 ? 10 : 70, precipitation: 0
      })) },
    bottom, seed: 17, synthetic: true
  };
}
