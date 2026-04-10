import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import { StatusBar } from 'expo-status-bar';
import {
  startTransition,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';
import type { Region } from 'react-native-maps';

const mapModule =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Platform.OS === 'web' ? null : (require('react-native-maps') as typeof import('react-native-maps'));
const MapView = mapModule?.default;
const Polygon = mapModule?.Polygon;

const STORAGE_KEY = 'fog-of-war/unlocked-cells-v1';
const METERS_PER_DEGREE_LATITUDE = 111_320;
const GRID_SIZE_METERS = 24;
const UNLOCK_RADIUS_METERS = 65;
const VIEWPORT_HEIGHT_METERS = 520;
const VIEWPORT_WIDTH_METERS = 300;
const LOCATION_DISTANCE_INTERVAL_METERS = 8;
const FOG_OVERLAP_METERS = 1;

type CellId = `${number}:${number}`;

type Coordinate = {
  latitude: number;
  longitude: number;
};

type CellDescriptor = {
  id: CellId;
  center: Coordinate;
  polygon: Coordinate[];
};

function metersToLatitudeDelta(meters: number) {
  return meters / METERS_PER_DEGREE_LATITUDE;
}

function metersToLongitudeDelta(meters: number, latitude: number) {
  const safeCosine = Math.max(Math.cos((latitude * Math.PI) / 180), 0.01);
  return meters / (METERS_PER_DEGREE_LATITUDE * safeCosine);
}

function latitudeDeltaToMeters(latitudeDelta: number) {
  return latitudeDelta * METERS_PER_DEGREE_LATITUDE;
}

function longitudeDeltaToMeters(longitudeDelta: number, latitude: number) {
  return longitudeDelta * METERS_PER_DEGREE_LATITUDE * Math.cos((latitude * Math.PI) / 180);
}

function getLatitudeStep() {
  return metersToLatitudeDelta(GRID_SIZE_METERS);
}

function getLongitudeStep(latitude: number) {
  return metersToLongitudeDelta(GRID_SIZE_METERS, latitude);
}

function getCellDescriptor(latitudeIndex: number, longitudeIndex: number): CellDescriptor {
  const latitudeStep = getLatitudeStep();
  const latitudeStart = latitudeIndex * latitudeStep;
  const latitudeEnd = latitudeStart + latitudeStep;
  const bandCenterLatitude = latitudeStart + latitudeStep / 2;
  const longitudeStep = getLongitudeStep(bandCenterLatitude);
  const longitudeStart = longitudeIndex * longitudeStep;
  const longitudeEnd = longitudeStart + longitudeStep;
  const latitudeOverlap = metersToLatitudeDelta(FOG_OVERLAP_METERS);
  const longitudeOverlap = metersToLongitudeDelta(FOG_OVERLAP_METERS, bandCenterLatitude);

  return {
    id: `${latitudeIndex}:${longitudeIndex}`,
    center: {
      latitude: bandCenterLatitude,
      longitude: longitudeStart + longitudeStep / 2,
    },
    polygon: [
      {
        latitude: latitudeStart - latitudeOverlap,
        longitude: longitudeStart - longitudeOverlap,
      },
      {
        latitude: latitudeStart - latitudeOverlap,
        longitude: longitudeEnd + longitudeOverlap,
      },
      {
        latitude: latitudeEnd + latitudeOverlap,
        longitude: longitudeEnd + longitudeOverlap,
      },
      {
        latitude: latitudeEnd + latitudeOverlap,
        longitude: longitudeStart - longitudeOverlap,
      },
    ],
  };
}

function circleIntersectsCell(circle: Coordinate, cell: CellDescriptor, radiusMeters: number) {
  const latitude = (circle.latitude + cell.center.latitude) / 2;
  const distanceX = Math.abs(
    longitudeDeltaToMeters(cell.center.longitude - circle.longitude, latitude)
  );
  const distanceY = Math.abs(latitudeDeltaToMeters(cell.center.latitude - circle.latitude));
  const halfCell = GRID_SIZE_METERS / 2;

  if (distanceX > halfCell + radiusMeters || distanceY > halfCell + radiusMeters) {
    return false;
  }

  if (distanceX <= halfCell || distanceY <= halfCell) {
    return true;
  }

  const cornerDistanceX = distanceX - halfCell;
  const cornerDistanceY = distanceY - halfCell;

  return (
    cornerDistanceX * cornerDistanceX + cornerDistanceY * cornerDistanceY <=
    radiusMeters * radiusMeters
  );
}

function getCellIdsInRadius(center: Coordinate, radiusMeters: number) {
  const latitudeStep = getLatitudeStep();
  const latitudeRadius = metersToLatitudeDelta(radiusMeters + GRID_SIZE_METERS);
  const minimumLatitudeIndex = Math.floor((center.latitude - latitudeRadius) / latitudeStep);
  const maximumLatitudeIndex = Math.floor((center.latitude + latitudeRadius) / latitudeStep);
  const cellIds: CellId[] = [];

  for (let latitudeIndex = minimumLatitudeIndex; latitudeIndex <= maximumLatitudeIndex; latitudeIndex += 1) {
    const bandCenterLatitude = (latitudeIndex + 0.5) * latitudeStep;
    const longitudeStep = getLongitudeStep(bandCenterLatitude);
    const longitudeRadius = metersToLongitudeDelta(radiusMeters + GRID_SIZE_METERS, bandCenterLatitude);
    const minimumLongitudeIndex = Math.floor((center.longitude - longitudeRadius) / longitudeStep);
    const maximumLongitudeIndex = Math.floor((center.longitude + longitudeRadius) / longitudeStep);

    for (
      let longitudeIndex = minimumLongitudeIndex;
      longitudeIndex <= maximumLongitudeIndex;
      longitudeIndex += 1
    ) {
      const cell = getCellDescriptor(latitudeIndex, longitudeIndex);

      if (circleIntersectsCell(center, cell, radiusMeters)) {
        cellIds.push(cell.id);
      }
    }
  }

  return cellIds;
}

function mergeUnlockedCells(existingCells: CellId[], nextCells: CellId[]) {
  if (nextCells.length === 0) {
    return existingCells;
  }

  const mergedCells = new Set(existingCells);
  let changed = false;

  for (const cellId of nextCells) {
    if (mergedCells.has(cellId)) {
      continue;
    }

    mergedCells.add(cellId);
    changed = true;
  }

  return changed ? Array.from(mergedCells) : existingCells;
}

function getViewportRegion(center: Coordinate): Region {
  return {
    latitude: center.latitude,
    longitude: center.longitude,
    latitudeDelta: metersToLatitudeDelta(VIEWPORT_HEIGHT_METERS),
    longitudeDelta: metersToLongitudeDelta(VIEWPORT_WIDTH_METERS, center.latitude),
  };
}

function getLockedFogPolygons(region: Region, unlockedCells: Set<CellId>) {
  const latitudeStep = getLatitudeStep();
  const minimumLatitude = region.latitude - region.latitudeDelta / 2;
  const maximumLatitude = region.latitude + region.latitudeDelta / 2;
  const minimumLatitudeIndex = Math.floor(minimumLatitude / latitudeStep);
  const maximumLatitudeIndex = Math.floor(maximumLatitude / latitudeStep);
  const polygons: CellDescriptor[] = [];

  for (let latitudeIndex = minimumLatitudeIndex; latitudeIndex <= maximumLatitudeIndex; latitudeIndex += 1) {
    const bandCenterLatitude = (latitudeIndex + 0.5) * latitudeStep;
    const longitudeStep = getLongitudeStep(bandCenterLatitude);
    const minimumLongitude = region.longitude - region.longitudeDelta / 2;
    const maximumLongitude = region.longitude + region.longitudeDelta / 2;
    const minimumLongitudeIndex = Math.floor(minimumLongitude / longitudeStep);
    const maximumLongitudeIndex = Math.floor(maximumLongitude / longitudeStep);

    for (
      let longitudeIndex = minimumLongitudeIndex;
      longitudeIndex <= maximumLongitudeIndex;
      longitudeIndex += 1
    ) {
      const cell = getCellDescriptor(latitudeIndex, longitudeIndex);

      if (!unlockedCells.has(cell.id)) {
        polygons.push(cell);
      }
    }
  }

  return polygons;
}

export default function MapScreen() {
  const [locationState, setLocationState] = useState<'loading' | 'denied' | 'ready'>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [currentLocation, setCurrentLocation] = useState<Coordinate | null>(null);
  const [unlockedCells, setUnlockedCells] = useState<CellId[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function loadUnlockedCells() {
      try {
        const storedValue = await AsyncStorage.getItem(STORAGE_KEY);

        if (cancelled || !storedValue) {
          return;
        }

        const parsedValue = JSON.parse(storedValue);

        if (Array.isArray(parsedValue)) {
          setUnlockedCells(parsedValue.filter((value): value is CellId => typeof value === 'string'));
        }
      } catch {
        if (!cancelled) {
          setErrorMessage('Could not load saved fog progress.');
        }
      } finally {
        if (!cancelled) {
          setStorageReady(true);
        }
      }
    }

    loadUnlockedCells();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!storageReady) {
      return;
    }

    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(unlockedCells)).catch(() => {
      setErrorMessage('Could not save fog progress.');
    });
  }, [storageReady, unlockedCells]);

  useEffect(() => {
    let active = true;
    let subscription: Location.LocationSubscription | null = null;
    const applyLocationUpdate = (nextLocation: Coordinate) => {
      setCurrentLocation(nextLocation);
      setLocationState('ready');
      setErrorMessage(null);

      startTransition(() => {
        const cellsToUnlock = getCellIdsInRadius(nextLocation, UNLOCK_RADIUS_METERS);
        setUnlockedCells((existingCells) => mergeUnlockedCells(existingCells, cellsToUnlock));
      });
    };

    async function startTracking() {
      try {
        const permission = await Location.requestForegroundPermissionsAsync();

        if (!active) {
          return;
        }

        if (permission.status !== Location.PermissionStatus.GRANTED) {
          setLocationState('denied');
          return;
        }

        const lastKnownPosition = await Location.getLastKnownPositionAsync();

        if (active && lastKnownPosition) {
          applyLocationUpdate(lastKnownPosition.coords);
        }

        const currentPosition = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.High,
        });

        if (!active) {
          return;
        }

        applyLocationUpdate(currentPosition.coords);

        subscription = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.High,
            distanceInterval: LOCATION_DISTANCE_INTERVAL_METERS,
            timeInterval: 3_000,
            mayShowUserSettingsDialog: true,
          },
          ({ coords }) => {
            applyLocationUpdate(coords);
          }
        );
      } catch {
        if (active) {
          setLocationState('denied');
          setErrorMessage('Location could not be started.');
        }
      }
    }

    startTracking();

    return () => {
      active = false;
      subscription?.remove();
    };
  }, []);

  const fogPolygons = useMemo(() => {
    if (!currentLocation) {
      return [];
    }

    return getLockedFogPolygons(getViewportRegion(currentLocation), new Set(unlockedCells));
  }, [currentLocation, unlockedCells]);

  if (Platform.OS === 'web' || !MapView || !Polygon) {
    return (
      <View style={styles.centeredScreen}>
        <StatusBar hidden />
        <Text style={styles.title}>Mobile only</Text>
        <Text style={styles.message}>
          This fog-of-war map uses native location and map views, so run it on iOS or Android.
        </Text>
      </View>
    );
  }

  if (locationState === 'denied') {
    return (
      <View style={styles.centeredScreen}>
        <StatusBar hidden />
        <Text style={styles.title}>Location required</Text>
        <Text style={styles.message}>
          Allow location access to reveal the map as you move around.
        </Text>
        {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}
      </View>
    );
  }

  if (!currentLocation) {
    return (
      <View style={styles.centeredScreen}>
        <StatusBar hidden />
        <ActivityIndicator size="large" color="#ffffff" />
        <Text style={styles.message}>Finding your position...</Text>
        {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}
      </View>
    );
  }

  const region = getViewportRegion(currentLocation);

  return (
    <View style={styles.container}>
      <StatusBar hidden />
      <MapView
        region={region}
        style={StyleSheet.absoluteFill}
        showsUserLocation
        showsMyLocationButton={false}
        showsCompass={false}
        toolbarEnabled={false}
        pitchEnabled={false}
        rotateEnabled={false}
        scrollEnabled={false}
        zoomEnabled={false}>
        {fogPolygons.map((cell) => (
          <Polygon
            key={cell.id}
            coordinates={cell.polygon}
            fillColor="rgba(0, 0, 0, 0.92)"
            strokeWidth={0}
          />
        ))}
      </MapView>
      {errorMessage ? (
        <View style={styles.errorBadge}>
          <Text style={styles.errorBadgeText}>{errorMessage}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#050505',
  },
  centeredScreen: {
    flex: 1,
    backgroundColor: '#050505',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    gap: 12,
  },
  title: {
    color: '#ffffff',
    fontSize: 28,
    fontWeight: '700',
    textAlign: 'center',
  },
  message: {
    color: 'rgba(255, 255, 255, 0.76)',
    fontSize: 16,
    lineHeight: 24,
    textAlign: 'center',
  },
  error: {
    color: '#ff8f8f',
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  errorBadge: {
    position: 'absolute',
    top: 56,
    left: 16,
    right: 16,
    backgroundColor: 'rgba(24, 24, 24, 0.86)',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  errorBadgeText: {
    color: '#ffffff',
    fontSize: 13,
    textAlign: 'center',
  },
});
