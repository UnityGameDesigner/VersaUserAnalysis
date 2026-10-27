// src/AuthGate.tsx — the dashboard requires a signed-in ADMIN (2026-10-26).
//
// This dashboard used to run unauthenticated on the anon key, which only worked because completed_lessons (and a few
// other tables) were readable by anyone holding that key — the same key ships inside the mobile app, so every
// transcript was public. Those reads are now closed (VersaFrontEnd supabase/migrations/20261026060000): learners see
// only their own rows; accounts listed in public.admin_users see everything. Sign in with such an account.
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './lib/supabase';

const box: React.CSSProperties = { maxWidth: 360, margin: '12vh auto', padding: 28, borderRadius: 16, background: '#fff', boxShadow: '0 8px 30px rgba(0,0,0,0.08)', fontFamily: 'system-ui, sans-serif' };
const input: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '10px 12px', margin: '6px 0', borderRadius: 10, border: '1px solid #ddd', fontSize: 15 };
const button: React.CSSProperties = { width: '100%', padding: '11px 12px', marginTop: 10, borderRadius: 10, border: 0, background: '#FD5D04', color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer' };

export default function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [admin, setAdmin] = useState<boolean | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => { setSession(data.session); setLoading(false); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => subscription.unsubscribe();
  }, []);
  useEffect(() => {
    if (!session) { setAdmin(null); return; }
    void supabase.rpc('is_admin').then(({ data, error: e }) => setAdmin(!e && data === true));
  }, [session]);

  const signIn = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const { error: err } = await supabase.auth.signInWithPassword({ email, password });
    if (err) setError(err.message);
  };

  if (loading || (session && admin === null)) return <div style={{ ...box, textAlign: 'center' }}>Loading…</div>;
  if (!session) {
    return (
      <form style={box} onSubmit={signIn}>
        <h2 style={{ margin: '0 0 4px' }}>Versa user analysis</h2>
        <p style={{ margin: '0 0 14px', color: '#666', fontSize: 14 }}>Sign in with an admin account.</p>
        <input style={input} type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input style={input} type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && <p style={{ color: '#B91C1C', fontSize: 13 }}>{error}</p>}
        <button style={button} type="submit">Sign in</button>
      </form>
    );
  }
  if (!admin) {
    return (
      <div style={box}>
        <h2 style={{ marginTop: 0 }}>Not an admin account</h2>
        <p style={{ color: '#555', fontSize: 14 }}>{session.user.email} is signed in but is not listed in admin_users, so learner data stays hidden.</p>
        <button style={button} onClick={() => { void supabase.auth.signOut(); }}>Sign out</button>
      </div>
    );
  }
  return (
    <>
      <button onClick={() => { void supabase.auth.signOut(); }} style={{ position: 'fixed', right: 12, bottom: 12, zIndex: 9999, padding: '6px 10px', borderRadius: 8, border: '1px solid #ddd', background: '#fff', cursor: 'pointer', fontSize: 12 }}>
        Sign out {session.user.email}
      </button>
      {children}
    </>
  );
}
