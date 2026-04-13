import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import { StatusBar } from 'expo-status-bar';
import {
  startTransition,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type NativeMapView from 'react-native-maps';
import type { MapStyleElement, Region } from 'react-native-maps';

const mapModule =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Platform.OS === 'web' ? null : (require('react-native-maps') as typeof import('react-native-maps'));
const MapView = mapModule?.default;
const Polygon = mapModule?.Polygon;

const STORAGE_KEY = 'fog-of-war/revealed-locations-v1';
const METERS_PER_DEGREE_LATITUDE = 111_320;
const UNLOCK_RADIUS_METERS = 65;
const VIEWPORT_HEIGHT_METERS = 520;
const VIEWPORT_WIDTH_METERS = 300;
const LOCATION_DISTANCE_INTERVAL_METERS = 8;
const REVEAL_POINT_MIN_DISTANCE_METERS = 12;
const FOG_REGION_OVERDRAW_FACTOR = 16;
const CIRCLE_SEGMENTS = 64;

const HIDDEN_MAP_LABEL_STYLE: MapStyleElement[] = [
  {
    elementType: 'labels',
    stylers: [{ visibility: 'off' }],
  },
  {
    featureType: 'poi',
    elementType: 'all',
    stylers: [{ visibility: 'off' }],
  },
  {
    featureType: 'transit.station',
    elementType: 'all',
    stylers: [{ visibility: 'off' }],
  },
];

type Coordinate = {
  latitude: number;
  longitude: number;
};

type CoordinateBounds = {
  minimumLatitude: number;
  maximumLatitude: number;
  minimumLongitude: number;
  maximumLongitude: number;
};

type FogMask = {
  coordinates: Coordinate[];
  holes: Coordinate[][];
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

function getViewportRegion(center: Coordinate): Region {
  return {
    latitude: center.latitude,
    longitude: center.longitude,
    latitudeDelta: metersToLatitudeDelta(VIEWPORT_HEIGHT_METERS),
    longitudeDelta: metersToLongitudeDelta(VIEWPORT_WIDTH_METERS, center.latitude),
  };
}

function getDistanceMeters(first: Coordinate, second: Coordinate) {
  const latitude = (first.latitude + second.latitude) / 2;

  return Math.hypot(
    longitudeDeltaToMeters(second.longitude - first.longitude, latitude),
    latitudeDeltaToMeters(second.latitude - first.latitude)
  );
}

function isCoordinate(value: unknown): value is Coordinate {
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

function mergeRevealedLocations(existingLocations: Coordinate[], nextLocation: Coordinate) {
  const nearbyLocation = existingLocations.some(
    (location) => getDistanceMeters(location, nextLocation) < REVEAL_POINT_MIN_DISTANCE_METERS
  );

  if (nearbyLocation) {
    return existingLocations;
  }

  return [...existingLocations, nextLocation];
}

function getFogBounds(region: Region): CoordinateBounds {
  const latitudeHalfDelta = (region.latitudeDelta * FOG_REGION_OVERDRAW_FACTOR) / 2;
  const longitudeHalfDelta = (region.longitudeDelta * FOG_REGION_OVERDRAW_FACTOR) / 2;

  return {
    minimumLatitude: region.latitude - latitudeHalfDelta,
    maximumLatitude: region.latitude + latitudeHalfDelta,
    minimumLongitude: region.longitude - longitudeHalfDelta,
    maximumLongitude: region.longitude + longitudeHalfDelta,
  };
}

function circleIntersectsBounds(center: Coordinate, radiusMeters: number, bounds: CoordinateBounds) {
  const latitudeRadius = metersToLatitudeDelta(radiusMeters);
  const longitudeRadius = metersToLongitudeDelta(radiusMeters, center.latitude);

  return (
    center.latitude + latitudeRadius >= bounds.minimumLatitude &&
    center.latitude - latitudeRadius <= bounds.maximumLatitude &&
    center.longitude + longitudeRadius >= bounds.minimumLongitude &&
    center.longitude - longitudeRadius <= bounds.maximumLongitude
  );
}

function getCircleHole(center: Coordinate, radiusMeters: number) {
  return Array.from({ length: CIRCLE_SEGMENTS }, (_, index) => {
    const angle = 2 * Math.PI - (index / CIRCLE_SEGMENTS) * 2 * Math.PI;
    const latitudeOffsetMeters = Math.sin(angle) * radiusMeters;
    const longitudeOffsetMeters = Math.cos(angle) * radiusMeters;

    return {
      latitude: center.latitude + metersToLatitudeDelta(latitudeOffsetMeters),
      longitude: center.longitude + metersToLongitudeDelta(longitudeOffsetMeters, center.latitude),
    };
  });
}

function getFogMask(region: Region, revealedLocations: Coordinate[]): FogMask {
  const bounds = getFogBounds(region);

  return {
    coordinates: [
      {
        latitude: bounds.minimumLatitude,
        longitude: bounds.minimumLongitude,
      },
      {
        latitude: bounds.minimumLatitude,
        longitude: bounds.maximumLongitude,
      },
      {
        latitude: bounds.maximumLatitude,
        longitude: bounds.maximumLongitude,
      },
      {
        latitude: bounds.maximumLatitude,
        longitude: bounds.minimumLongitude,
      },
    ],
    holes: revealedLocations
      .filter((location) => circleIntersectsBounds(location, UNLOCK_RADIUS_METERS, bounds))
      .map((location) => getCircleHole(location, UNLOCK_RADIUS_METERS)),
  };
}

export default function MapScreen() {
  const mapRef = useRef<NativeMapView | null>(null);
  const [locationState, setLocationState] = useState<'loading' | 'denied' | 'ready'>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [currentLocation, setCurrentLocation] = useState<Coordinate | null>(null);
  const [mapRegion, setMapRegion] = useState<Region | null>(null);
  const [revealedLocations, setRevealedLocations] = useState<Coordinate[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function loadRevealedLocations() {
      try {
        const storedValue = await AsyncStorage.getItem(STORAGE_KEY);

        if (cancelled || !storedValue) {
          return;
        }

        const parsedValue = JSON.parse(storedValue);

        if (Array.isArray(parsedValue)) {
          setRevealedLocations(parsedValue.filter(isCoordinate));
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

    loadRevealedLocations();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!storageReady) {
      return;
    }

    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(revealedLocations)).catch(() => {
      setErrorMessage('Could not save fog progress.');
    });
  }, [storageReady, revealedLocations]);

  useEffect(() => {
    if (!storageReady) {
      return;
    }

    let active = true;
    let subscription: Location.LocationSubscription | null = null;
    const applyLocationUpdate = (nextLocation: Coordinate) => {
      setCurrentLocation(nextLocation);
      setMapRegion((existingRegion) => existingRegion ?? getViewportRegion(nextLocation));
      setLocationState('ready');
      setErrorMessage(null);

      startTransition(() => {
        setRevealedLocations((existingLocations) =>
          mergeRevealedLocations(existingLocations, nextLocation)
        );
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
  }, [storageReady]);

  const fogMask = useMemo(() => {
    const visibleRegion = mapRegion ?? (currentLocation ? getViewportRegion(currentLocation) : null);

    if (!visibleRegion) {
      return null;
    }

    return getFogMask(visibleRegion, revealedLocations);
  }, [currentLocation, mapRegion, revealedLocations]);

  const recenterMap = () => {
    if (!currentLocation) {
      return;
    }

    const nextRegion = getViewportRegion(currentLocation);
    setMapRegion(nextRegion);
    mapRef.current?.animateToRegion(nextRegion, 250);
  };

  if (Platform.OS === 'web' || !MapView || !Polygon) {
    return (
      <View style={styles.centeredScreen}>
        <StatusBar style="light" />
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
        <StatusBar style="light" />
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
        <StatusBar style="light" />
        <ActivityIndicator size="large" color="#ffffff" />
        <Text style={styles.message}>Finding your position...</Text>
        {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}
      </View>
    );
  }

  const region = mapRegion ?? getViewportRegion(currentLocation);

  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      <MapView
        ref={mapRef}
        onRegionChange={setMapRegion}
        onRegionChangeComplete={setMapRegion}
        initialRegion={region}
        style={StyleSheet.absoluteFill}
        customMapStyle={HIDDEN_MAP_LABEL_STYLE}
        showsPointsOfInterest={false}
        showsUserLocation
        showsMyLocationButton={false}
        showsCompass={false}
        poiClickEnabled={false}
        toolbarEnabled={false}
        pitchEnabled={false}
        rotateEnabled={false}
        scrollEnabled
        zoomEnabled>
        {fogMask ? (
          <Polygon
            coordinates={fogMask.coordinates}
            fillColor="#000000"
            holes={fogMask.holes}
            strokeWidth={0}
          />
        ) : null}
      </MapView>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Center map on current location"
        onPress={recenterMap}
        style={({ pressed }) => [
          styles.centerButton,
          pressed ? styles.centerButtonPressed : null,
        ]}>
        <Text style={styles.centerButtonText}>Center</Text>
      </Pressable>
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
  centerButton: {
    position: 'absolute',
    right: 16,
    bottom: 28,
    minHeight: 44,
    minWidth: 88,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ffffff',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  centerButtonPressed: {
    opacity: 0.78,
  },
  centerButtonText: {
    color: '#050505',
    fontSize: 15,
    fontWeight: '700',
  },
});
