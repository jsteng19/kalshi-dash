import { NextRequest, NextResponse } from 'next/server';
import { writeEvents, EventInput } from '@/lib/tierHistory';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!Array.isArray(body?.events)) {
      return NextResponse.json({ error: 'events[] required' }, { status: 400 });
    }
    const items = body.events as EventInput[];
    const { written } = writeEvents(items);
    return NextResponse.json({ written });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
