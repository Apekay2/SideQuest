import { metresBetween, humanDistance, regionFor } from './geo';

describe('geo', () => {
  test('distance across Nairobi is right to within a few percent', () => {
    // Kangemi Market to Kilimani (Wood Ave): ~4.6 km straight line.
    const d = metresBetween({ lat: -1.2641, lng: 36.7519 }, { lat: -1.2921, lng: 36.7836 });
    expect(d).toBeGreaterThan(4500);
    expect(d).toBeLessThan(4800);
  });
  test('distances read at a useful precision', () => {
    expect(humanDistance(3)).toBe('10 m');
    expect(humanDistance(347)).toBe('350 m');
    expect(humanDistance(1234)).toBe('1.2 km');
    expect(humanDistance(15_400)).toBe('15 km');
  });
  test('the region holds every point, never zoomed in past a few streets', () => {
    const r = regionFor([{ lat: -1.26, lng: 36.75 }, { lat: -1.29, lng: 36.78 }]);
    expect(r.latitude).toBeCloseTo(-1.275, 3);
    expect(r.latitudeDelta).toBeGreaterThan(0.03);
    expect(regionFor([{ lat: -1.26, lng: 36.75 }]).latitudeDelta).toBe(0.006);
  });
});
