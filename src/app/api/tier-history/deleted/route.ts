import { NextRequest, NextResponse } from 'next/server';
import { getAllDeleted, recordDeletions, NewDeletionInput } from '@/lib/tierHistory';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const m = getAllDeleted();
    const out: Record<string, string> = {};
    m.forEach((v, k) => { out[k] = v.last_trade_at_deletion; });
    return NextResponse.json({ deleted: out });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!Array.isArray(body?.deletions)) {
      return NextResponse.json({ error: 'deletions[] required' }, { status: 400 });
    }
    const items = body.deletions as NewDeletionInput[];
    const { written } = recordDeletions(items);
    return NextResponse.json({ written });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
