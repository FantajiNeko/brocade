import { useState } from 'react';

/** Wait for complete dependencies on entry, then keep the mounted surface during refreshes.
 * This only latches visibility; callers must still block writes when current dependencies fail
 * or are pending. Changing the resource identity starts a new initial load.
 */
export function useInitialReady(ready: boolean, identity: string): boolean {
  const [revealed, setRevealed] = useState({ identity, ready });
  if (revealed.identity !== identity) {
    setRevealed({ identity, ready });
    return ready;
  }
  if (ready && !revealed.ready) setRevealed({ identity, ready: true });
  return ready || revealed.ready;
}
