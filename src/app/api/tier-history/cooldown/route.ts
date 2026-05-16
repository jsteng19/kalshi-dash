import { NextResponse } from 'next/server';
import { getAllCooldowns } from '@/lib/tierHistory';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const m = getAllCooldowns();
    const out: Record<string, any> = {};
    m.forEach((v, k) => { out[k] = v; });
    return NextResponse.json({ cooldowns: out });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
