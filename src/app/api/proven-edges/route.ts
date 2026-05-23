// Proven Edges API: Get the allowlist of proven trading setups
// These are the ONLY combos the auto-trader will trade in strict mode.

import { NextResponse } from 'next/server';
import { getAllProvenEdges, getBlockedPatterns, getProvenEdgesStats, getEdgesByTier } from '@/lib/proven-edges';

export async function GET() {
  try {
    const [edges, blocked, stats, tier1, tier2, tier3] = [
      getAllProvenEdges(),
      getBlockedPatterns(),
      getProvenEdgesStats(),
      getEdgesByTier('TIER_1'),
      getEdgesByTier('TIER_2'),
      getEdgesByTier('TIER_3'),
    ];

    return NextResponse.json({
      stats,
      edges,
      tier1,
      tier2,
      tier3,
      blockedPatterns: blocked,
      message: 'En modo estricto (strictMode=true), SOLO los combos en edges se operan. Todo lo demás → NO OPERAR.',
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
