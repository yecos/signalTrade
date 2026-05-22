// Learning Engine API: Edge discovery, regime detection, setup recommendations, feature importance

import { NextRequest, NextResponse } from 'next/server';
import { runLearningAnalysis, getSetupRecommendations, hasEdge, calculateFeatureImportance } from '@/lib/learning-engine';

// GET: Learning report, setup recommendations, edge check, or feature importance
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const mode = searchParams.get('mode');

    if (mode === 'recommendations') {
      const recommendations = await getSetupRecommendations();
      return NextResponse.json({ recommendations });
    }

    if (mode === 'edge-check') {
      const pattern = searchParams.get('pattern');
      const session = searchParams.get('session') || 'OffHours';
      const asset = searchParams.get('asset') || 'EUR/USD';
      const edge = await hasEdge(pattern, session, asset);
      return NextResponse.json(edge);
    }

    if (mode === 'feature-importance') {
      const importance = await calculateFeatureImportance();
      return NextResponse.json(importance);
    }

    // Default: full learning report
    const report = await runLearningAnalysis();
    return NextResponse.json(report);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
