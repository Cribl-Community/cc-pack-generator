/**
 * One browser-history entry per pack-build wizard session so Back returns to
 * Home inside the app instead of leaving Cribl entirely.
 */
import { useEffect, useRef } from 'react';

export function useWizardHistoryGuard(active: boolean, onPopHome: () => void): void {
  const armed = useRef(false);
  const onPopHomeRef = useRef(onPopHome);
  onPopHomeRef.current = onPopHome;

  useEffect(() => {
    if (!active) {
      armed.current = false;
      return;
    }
    if (!armed.current) {
      window.history.pushState({ pgWizard: true }, '');
      armed.current = true;
    }
    const onPop = () => {
      armed.current = false;
      onPopHomeRef.current();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [active]);
}
