// Setup Scores API: Get pattern/session performance data

import { NextResponse } from 'next/server';
import { getSetupScores } from '@/lib/auto-trader';

// GET: Get all setup scores
export async function GET() {
  try {
    const scores = await getSetupScores();
    
    // Group by pattern for summary
    const byPattern: Record<string, { totalSignals: number; wins: number; losses: number; winRate: number; edge: string }> = {};
    scores.forEach(s => {
      const key = s.patternType;
      if (!byPattern[key]) byPattern[key] = { totalSignals: 0, wins: 0, losses: 0, winRate: 0, edge: 'UNKNOWN' };
      byPattern[key].totalSignals += s.totalSignals;
      byPattern[key].wins += s.wins;
      byPattern[key].losses += s.losses;
    });
    
    Object.entries(byPattern).forEach(([key, data]) => {
      const decisive = data.wins + data.losses;
      data.winRate = decisive > 0 ? Math.round((data.wins / decisive) * 1000) / 10 : 0;
      data.edge = decisive < 10 ? 'UNKNOWN' : data.winRate > 55 ? 'POSITIVE' : data.winRate < 45 ? 'NEGATIVE' : 'NEUTRAL';
    });
    
    // Group by session
    const bySession: Record<string, { totalSignals: number; wins: number; losses: number; winRate: number; edge: string }> = {};
    scores.forEach(s => {
      const key = s.session || 'all';
      if (!bySession[key]) bySession[key] = { totalSignals: 0, wins: 0, losses: 0, winRate: 0, edge: 'UNKNOWN' };
      bySession[key].totalSignals += s.totalSignals;
      bySession[key].wins += s.wins;
      bySession[key].losses += s.losses;
    });
    
    Object.entries(bySession).forEach(([key, data]) => {
      const decisive = data.wins + data.losses;
      data.winRate = decisive > 0 ? Math.round((data.wins / decisive) * 1000) / 10 : 0;
      data.edge = decisive < 10 ? 'UNKNOWN' : data.winRate > 55 ? 'POSITIVE' : data.winRate < 45 ? 'NEGATIVE' : 'NEUTRAL';
    });
    
    return NextResponse.json({
      scores,
      summary: {
        byPattern,
        bySession,
        totalPatterns: Object.keys(byPattern).length,
        totalSessions: Object.keys(bySession).length,
        totalDataPoints: scores.reduce((sum, s) => sum + s.totalSignals, 0),
      },
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
