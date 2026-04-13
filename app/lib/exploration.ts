export const STORAGE_KEY = 'fog-of-war/revealed-locations-v1';
export const METERS_PER_DEGREE_LATITUDE = 111_320;
export const UNLOCK_RADIUS_METERS = 65;
export const AREA_ESTIMATE_CELL_SIZE_METERS = 10;

export type Coordinate = {
  latitude: number;
  longitude: number;
};

export function metersToLatitudeDelta(meters: number) {
  return meters / METERS_PER_DEGREE_LATITUDE;
}

export function metersToLongitudeDelta(meters: number, latitude: number) {
  const safeCosine = Math.max(Math.cos((latitude * Math.PI) / 180), 0.01);
  return meters / (METERS_PER_DEGREE_LATITUDE * safeCosine);
}

export function latitudeDeltaToMeters(latitudeDelta: number) {
  return latitudeDelta * METERS_PER_DEGREE_LATITUDE;
}

export function longitudeDeltaToMeters(longitudeDelta: number, latitude: number) {
  return longitudeDelta * METERS_PER_DEGREE_LATITUDE * Math.cos((latitude * Math.PI) / 180);
}

export function getDistanceMeters(first: Coordinate, second: Coordinate) {
  const latitude = (first.latitude + second.latitude) / 2;

  return Math.hypot(
    longitudeDeltaToMeters(second.longitude - first.longitude, latitude),
    latitudeDeltaToMeters(second.latitude - first.latitude)
  );
}

export function isCoordinate(value: unknown): value is Coordinate {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Partial<Coordinate>;

  return (
    typeof candidate.latitude === 'number' &&
    typeof candidate.longitude === 'number' &&
    Number.isFinite(candidate.latitude) &&
    Number.isFinite(candidate.longitude) &&
    candidate.latitude >= -90 &&
    candidate.latitude <= 90 &&
    candidate.longitude >= -180 &&
    candidate.longitude <= 180
  );
}

export function getExploredAreaSquareMeters(revealedLocations: Coordinate[]) {
  if (revealedLocations.length === 0) {
    return 0;
  }

  const origin = revealedLocations[0];
  const occupiedCells = new Set<string>();

  for (const location of revealedLocations) {
    const centerX = longitudeDeltaToMeters(location.longitude - origin.longitude, origin.latitude);
    const centerY = latitudeDeltaToMeters(location.latitude - origin.latitude);
    const minimumX = Math.floor(
      (centerX - UNLOCK_RADIUS_METERS) / AREA_ESTIMATE_CELL_SIZE_METERS
    );
    const maximumX = Math.ceil(
      (centerX + UNLOCK_RADIUS_METERS) / AREA_ESTIMATE_CELL_SIZE_METERS
    );
    const minimumY = Math.floor(
      (centerY - UNLOCK_RADIUS_METERS) / AREA_ESTIMATE_CELL_SIZE_METERS
    );
    const maximumY = Math.ceil(
      (centerY + UNLOCK_RADIUS_METERS) / AREA_ESTIMATE_CELL_SIZE_METERS
    );

    for (let x = minimumX; x <= maximumX; x += 1) {
      const sampleX = (x + 0.5) * AREA_ESTIMATE_CELL_SIZE_METERS;

      for (let y = minimumY; y <= maximumY; y += 1) {
        const sampleY = (y + 0.5) * AREA_ESTIMATE_CELL_SIZE_METERS;

        if (
          Math.hypot(sampleX - centerX, sampleY - centerY) <= UNLOCK_RADIUS_METERS
        ) {
          occupiedCells.add(`${x}:${y}`);
        }
      }
    }
  }

  return occupiedCells.size * AREA_ESTIMATE_CELL_SIZE_METERS ** 2;
}
