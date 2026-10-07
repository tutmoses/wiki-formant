'use client';

// passkey-button.tsx – the browser half of `wiki-formant/passkey`.
//
// Its own subpath because it imports `@simplewebauthn/browser`, an optional
// peer that only an app with a passkey door installs. With an invite it saves a
// new passkey; without one it signs in with a saved one. Either way, success
// reloads the page without the invite, and the server sees the new cookie.

import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { useState } from 'react';

export interface PasskeyButtonProps {
  /** The route that serves `gate.route`. */
  endpoint: string;
  /** The invite token from the link, when there is one. */
  invite?: string | undefined;
  className?: string;
  errorClassName?: string;
}

async function post(endpoint: string, body: unknown) {
  const res = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? 'Sign-in failed.');
  return res.status === 204 ? null : res.json();
}

export function PasskeyButton({ endpoint, invite, className, errorClassName }: PasskeyButtonProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const optionsJSON = await post(endpoint, { invite });
      const response = invite ? await startRegistration({ optionsJSON }) : await startAuthentication({ optionsJSON });
      await post(endpoint, { invite, response });
      location.replace(location.pathname + location.search.replace(/([?&])invite=[^&]*&?/, '$1').replace(/[?&]$/, ''));
    } catch (e) {
      // A prompt the person closed throws NotAllowedError, which needs no message.
      setError(e instanceof Error && e.name !== 'NotAllowedError' ? e.message : null);
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className={className} onClick={go} disabled={busy}>
        {invite ? 'Save a passkey' : 'Sign in with a passkey'}
      </button>
      {error && (
        <p role="alert" className={errorClassName}>
          {error}
        </p>
      )}
    </>
  );
}
