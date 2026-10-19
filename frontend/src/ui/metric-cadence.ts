import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { hashKey, useQuery, type DefaultError, type QueryKey, type UseQueryOptions } from '@tanstack/react-query';
import { subscribeClock } from './clock';

/** Presentation only: keep the latest complete reading until the shared second boundary.
 * First data, identity/range changes and explicit facts are immediate. No interpolation,
 * averaging or timestamp rewriting: gaps and freshness still belong to the source. */
export function useMetricValue<T>(value: T, identity: string, facts = ''): T {
  const scope = `${identity}\n${facts}`;
  const [shown, setShown] = useState(() => ({ scope, value }));
  const pending = useRef({ scope, value });
  useLayoutEffect(() => {
    pending.current = { scope, value };
  }, [scope, value]);
  useEffect(() => subscribeClock(() => setShown(pending.current)), []);

  if (shown.scope !== scope || (shown.value == null) !== (value == null)) {
    setShown({ scope, value });
    return value;
  }
  return shown.value;
}

/** Only metric queries opt in. Mutations, configuration, jobs and connection events continue
 * through useQuery unchanged; errors/loading also remain immediate. The query cache itself is
 * authoritative and untouched, including prefetch, invalidation and cancellation semantics. */
export function useMetricQuery<
  TQueryFnData,
  TError = DefaultError,
  TData = TQueryFnData,
  TKey extends QueryKey = QueryKey,
>(options: UseQueryOptions<TQueryFnData, TError, TData, TKey> & { metricFacts?: (data: TData) => unknown }) {
  const { metricFacts, ...queryOptions } = options;
  const query = useQuery(queryOptions);
  // Resolving a placeholder is the first real reading of a new identity/range. Its old data
  // must not linger after Query has already cleared isPlaceholderData.
  const facts = JSON.stringify([
    query.isPlaceholderData,
    query.data === undefined || !metricFacts ? null : metricFacts(query.data),
  ]);
  const reading = useMemo(
    () => (query.data === undefined ? undefined : { data: query.data, updatedAt: query.dataUpdatedAt }),
    [query.data, query.dataUpdatedAt],
  );
  const displayed = useMetricValue(reading, hashKey(options.queryKey), facts);
  return { ...query, data: displayed?.data, dataUpdatedAt: displayed?.updatedAt ?? query.dataUpdatedAt };
}
