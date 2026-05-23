// Edge Profile API: Get classification of all trading setup combos

import { NextResponse } from 'next/server';
import { getEdgeProfile, getGreenEdges, getRedEdges, getTradingFocus, getEdgeProfileSummary } from '@/lib/edge-profile';

// GET: Get the full edge profile
export async function GET() {
  try {
    const [profile, greenEdges, redEdges, focus] = await Promise.all([
      getEdgeProfile(),
      getGreenEdges(),
      getRedEdges(),
      getTradingFocus(),
    ]);

    return NextResponse.json({
      summary: {
        greenCount: profile.greenCount,
        yellowCount: profile.yellowCount,
        redCount: profile.redCount,
        greyCount: profile.greyCount,
        totalCombos: profile.totalCombos,
        loadedAt: profile.loadedAt,
      },
      greenEdges,
      redEdges,
      tradingFocus: focus,
      entries: profile.entries,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
