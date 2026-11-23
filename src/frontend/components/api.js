import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@forge/bridge';

/** Calls a resolver and turns `{ error }` responses into exceptions. */
export async function call(name, payload = {}) {
  const res = await invoke(name, payload);
  if (res && typeof res === 'object' && !Array.isArray(res) && res.error) {
    const err = new Error(res.error);
    err.forbidden = Boolean(res.forbidden);
    throw err;
  }
  return res;
}

/** Loads data with a resolver call and exposes { data, loading, error, reload }. */
export function useLoad(name, payload, deps = []) {
  const [state, setState] = useState({ data: null, loading: true, error: null });
  const key = JSON.stringify(payload || {});
  const reload = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await call(name, payload || {});
      setState({ data, loading: false, error: null });
    } catch (err) {
      setState({ data: null, loading: false, error: err.message });
    }
  }, [name, key, ...deps]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { ...state, reload };
}
