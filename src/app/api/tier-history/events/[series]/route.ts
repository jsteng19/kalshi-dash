import { NextRequest, NextResponse } from 'next/server';
import { getEvents, getState } from '@/lib/tierHistory';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: { series: string } }) {
  try {
    const series = decodeURIComponent(params.series);
    if (!series) return NextResponse.json({ error: 'series required' }, { status: 400 });
    return NextResponse.json({
      state: getState(series),
      events: getEvents(series, 90),
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
