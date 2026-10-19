/** Console receipt time is the protocol's shared timeline. Compare only observations for the
 * same node; Agent sequence can restart and Agent clocks cannot order different machines. */
interface OrderedEvent {
  received_at_unix_millis: number;
  sample?: { sequence?: number };
}

export function olderRealtimeEvent(incoming: OrderedEvent, previous: OrderedEvent | null | undefined): boolean {
  if (!previous) return false;
  if (incoming.received_at_unix_millis !== previous.received_at_unix_millis)
    return incoming.received_at_unix_millis < previous.received_at_unix_millis;
  // Buffered frames can reach Console in the same millisecond. Sequence only breaks that tie;
  // a later receipt with a restarted sequence must still be accepted after an Agent reconnect.
  return (
    incoming.sample?.sequence !== undefined &&
    previous.sample?.sequence !== undefined &&
    incoming.sample.sequence < previous.sample.sequence
  );
}
