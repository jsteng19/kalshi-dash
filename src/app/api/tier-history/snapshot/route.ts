import { NextRequest, NextResponse } from 'next/server';
import { writeSnapshots, SnapshotInput } from '@/lib/tierHistory';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!Array.isArray(body?.snapshots)) {
      return NextResponse.json({ error: 'snapshots[] required' }, { status: 400 });
    }
    const snaps = body.snapshots as SnapshotInput[];
    const { written } = writeSnapshots(snaps);
    return NextResponse.json({ written });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
