'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';

export default function Home() {
  const { ready, isAuthed } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (!ready) return;
    router.replace(isAuthed ? '/dashboard' : '/login');
  }, [ready, isAuthed, router]);
  return <main className="grid h-full place-items-center text-slate-500">Loading…</main>;
}
