import { NextRequest, NextResponse } from 'next/server';
import { getHistory, getCooldown } from '@/lib/tierHistory';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: { series: string } }) {
  try {
    const series = params.series;
    if (!series) return NextResponse.json({ error: 'series required' }, { status: 400 });
    return NextResponse.json({
      cooldown: getCooldown(series),
      history: getHistory(series, 60),
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
