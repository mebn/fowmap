import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  getExploredAreaSquareMeters,
  isCoordinate,
  STORAGE_KEY,
  UNLOCK_RADIUS_METERS,
} from '../lib/exploration';
import type { Coordinate } from '../lib/exploration';

const integerFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0,
});

const compactFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
});

function formatArea(squareMeters: number) {
  if (squareMeters >= 1_000_000) {
    return `${compactFormatter.format(squareMeters / 1_000_000)} sq km`;
  }

  return `${integerFormatter.format(squareMeters)} sq m`;
}

export default function StatsScreen() {
  const router = useRouter();
  const [revealedLocations, setRevealedLocations] = useState<Coordinate[]>([]);
  const [screenState, setScreenState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;

    async function loadRevealedLocations() {
      try {
        const storedValue = await AsyncStorage.getItem(STORAGE_KEY);

        if (cancelled) {
          return;
        }

        if (!storedValue) {
          setRevealedLocations([]);
          setScreenState('ready');
          return;
        }

        const parsedValue = JSON.parse(storedValue);

        setRevealedLocations(Array.isArray(parsedValue) ? parsedValue.filter(isCoordinate) : []);
        setScreenState('ready');
      } catch {
        if (!cancelled) {
          setScreenState('error');
        }
      }
    }

    loadRevealedLocations();

    return () => {
      cancelled = true;
    };
  }, []);

  const exploredAreaSquareMeters = useMemo(
    () => getExploredAreaSquareMeters(revealedLocations),
    [revealedLocations]
  );

  const goBack = () => {
    router.back();
  };

  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Go back to map"
        onPress={goBack}
        style={({ pressed }) => [
          styles.backButton,
          pressed ? styles.controlButtonPressed : null,
        ]}>
        <Text style={styles.backButtonText}>Back</Text>
      </Pressable>

      <View style={styles.content}>
        <Text style={styles.eyebrow}>Exploration</Text>
        <Text style={styles.title}>Total area explored</Text>

        {screenState === 'loading' ? (
          <View style={styles.loadingArea}>
            <ActivityIndicator size="large" color="#ffffff" />
            <Text style={styles.message}>Loading saved progress...</Text>
          </View>
        ) : null}

        {screenState === 'error' ? (
          <Text style={styles.error}>Could not load saved fog progress.</Text>
        ) : null}

        {screenState === 'ready' ? (
          <View style={styles.statsBlock}>
            <Text style={styles.areaValue}>{formatArea(exploredAreaSquareMeters)}</Text>
            <Text style={styles.message}>
              Covered by your discovered map so far.
            </Text>

            <View style={styles.detailList}>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Reveal points</Text>
                <Text style={styles.detailValue}>
                  {integerFormatter.format(revealedLocations.length)}
                </Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Reveal radius</Text>
                <Text style={styles.detailValue}>{UNLOCK_RADIUS_METERS} m</Text>
              </View>
            </View>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#050505',
  },
  backButton: {
    position: 'absolute',
    top: 56,
    left: 16,
    zIndex: 1,
    minHeight: 44,
    minWidth: 76,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ffffff',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  controlButtonPressed: {
    opacity: 0.78,
  },
  backButtonText: {
    color: '#050505',
    fontSize: 15,
    fontWeight: '700',
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 96,
  },
  eyebrow: {
    color: 'rgba(255, 255, 255, 0.64)',
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0,
    marginBottom: 10,
    textTransform: 'uppercase',
  },
  title: {
    color: '#ffffff',
    fontSize: 34,
    fontWeight: '800',
    lineHeight: 40,
    marginBottom: 28,
  },
  loadingArea: {
    alignItems: 'flex-start',
    gap: 14,
  },
  statsBlock: {
    gap: 18,
  },
  areaValue: {
    color: '#ffffff',
    fontSize: 48,
    fontWeight: '800',
    lineHeight: 56,
  },
  message: {
    color: 'rgba(255, 255, 255, 0.76)',
    fontSize: 16,
    lineHeight: 24,
  },
  error: {
    color: '#ff8f8f',
    fontSize: 16,
    lineHeight: 24,
  },
  detailList: {
    marginTop: 14,
    borderTopColor: 'rgba(255, 255, 255, 0.2)',
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  detailRow: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 18,
    borderBottomColor: 'rgba(255, 255, 255, 0.2)',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  detailLabel: {
    color: 'rgba(255, 255, 255, 0.66)',
    flex: 1,
    fontSize: 15,
  },
  detailValue: {
    color: '#ffffff',
    flexShrink: 0,
    fontSize: 16,
    fontWeight: '700',
  },
});
