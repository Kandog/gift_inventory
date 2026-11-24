import { useMemo } from 'react';
import type { Category, Gift, Location } from '@gifts/shared';
import type { EventSummary } from './reportTypes';
import { useApi } from './ui';

/** Gifts, Locations, Categories and Events, with id → name helpers. */
export function useLookups() {
  const gifts = useApi<Gift[]>('/api/gifts');
  const locations = useApi<Location[]>('/api/locations');
  const categories = useApi<Category[]>('/api/categories');
  const events = useApi<EventSummary[]>('/api/events');
  return useMemo(() => {
    const giftName = new Map((gifts.data ?? []).map((g) => [g.id, g.name]));
    const locName = new Map((locations.data ?? []).map((l) => [l.id, l.name]));
    const catName = new Map((categories.data ?? []).map((c) => [c.id, c.name]));
    const evName = new Map((events.data ?? []).map((e) => [e.id, e.name]));
    // Merged-away Events are not in the summary list, so fall back to the id.
    return {
      ready: !!(gifts.data && locations.data && categories.data && events.data),
      gifts: gifts.data ?? [],
      locations: locations.data ?? [],
      categories: categories.data ?? [],
      events: events.data ?? [],
      giftName: (id: string) => giftName.get(id) ?? '(unknown Gift)',
      locName: (id: string | null) => (id ? (locName.get(id) ?? '?') : ''),
      catName: (id: string | null) => (id ? (catName.get(id) ?? '') : ''),
      evName: (id: string | null) => (id ? (evName.get(id) ?? '(merged Event)') : ''),
      reload: () => Promise.all([gifts.reload(), locations.reload(), categories.reload(), events.reload()]),
    };
  }, [gifts, locations, categories, events]);
}
