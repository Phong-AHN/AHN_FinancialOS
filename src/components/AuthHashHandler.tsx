'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

/**
 * Catches the implicit-flow sign-in that the server callback cannot see.
 *
 * When a Supabase project is set to the implicit flow, the email link lands with
 * the session in the URL **fragment** (`#access_token=...&refresh_token=...`).
 * Fragments are never transmitted to the server, so `/api/auth/callback` sees a
 * bare URL and can only report that no token arrived. This component runs in the
 * browser, where the fragment is readable, and completes the sign-in.
 *
 * The session is written through `createBrowserClient`, which stores it in
 * cookies rather than localStorage - so the server components pick it up on the
 * very next navigation.
 */
export function AuthHashHandler() {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
    if (!hash) return;

    const params = new URLSearchParams(hash);
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');
    const errorDescription = params.get('error_description');

    if (errorDescription) {
      setStatus(errorDescription);
      window.history.replaceState(null, '', window.location.pathname);
      return;
    }
    if (!accessToken || !refreshToken) return;

    setStatus('Completing sign-in…');
    void (async () => {
      const supabase = createSupabaseBrowserClient();
      const { error } = await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });

      // Clear the tokens out of the address bar either way - they should not
      // sit in browser history or get pasted into a bug report.
      window.history.replaceState(null, '', window.location.pathname);

      if (error) {
        setStatus(error.message);
      } else {
        router.push('/');
        router.refresh();
      }
    })();
  }, [router]);

  if (!status) return null;

  return (
    <p className="mt-4 text-center text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
      {status}
    </p>
  );
}
