import { useCallback, useMemo, useRef, useState } from 'react';
import { TaskSession, type TaskEventType, type TaskState } from '@orka/contracts';

/**
 * Bridges the framework-agnostic `TaskSession` deep module into React state.
 * The component tree never encodes transition rules itself -- it only reads
 * `state`/`can` and calls `send`/`stop`.
 */
export function useTaskSession() {
  const sessionRef = useRef<TaskSession | null>(null);
  if (!sessionRef.current) {
    sessionRef.current = new TaskSession();
  }
  const session = sessionRef.current;

  const [state, setState] = useState<TaskState>(session.state);
  const [actionCount, setActionCount] = useState(session.actionCount);

  const sync = useCallback(() => {
    setState(session.state);
    setActionCount(session.actionCount);
  }, [session]);

  const send = useCallback(
    (event: TaskEventType) => {
      if (!session.can(event)) return false;
      session.send(event);
      sync();
      return true;
    },
    [session, sync],
  );

  const stop = useCallback(() => {
    const stopped = session.stop();
    if (stopped) sync();
    return stopped;
  }, [session, sync]);

  const recordAction = useCallback(() => {
    const result = session.recordAction();
    sync();
    return result;
  }, [session, sync]);

  const can = useCallback((event: TaskEventType) => session.can(event), [session]);

  return useMemo(
    () => ({ state, actionCount, can, send, stop, recordAction }),
    [state, actionCount, can, send, stop, recordAction],
  );
}
