// Auto-Trader API: Start, Stop, Status, Run Cycle

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { 
  runAutoTraderCycle, 
  getAutoTraderState, 
  DEFAULT_CONFIG,
  type AutoTraderConfig 
} from '@/lib/auto-trader';

// GET: Get auto-trader status
export async function GET() {
  try {
    const state = await getAutoTraderState();
    
    // Get current config from settings
    const configSetting = await db.appSettings.findUnique({ where: { key: 'autoTraderConfig' } });
    const config = configSetting ? JSON.parse(configSetting.value) : DEFAULT_CONFIG;
    
    return NextResponse.json({
      state,
      config,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// POST: Control auto-trader (start/stop/run-cycle)
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const action = body.action; // 'start', 'stop', 'run-cycle', 'update-config'
    
    switch (action) {
      case 'start': {
        await db.appSettings.upsert({
          where: { key: 'autoTraderRunning' },
          create: { key: 'autoTraderRunning', value: 'true', description: 'Auto-trader is running' },
          update: { value: 'true' },
        });
        
        // Save config
        const config = body.config || DEFAULT_CONFIG;
        await db.appSettings.upsert({
          where: { key: 'autoTraderConfig' },
          create: { key: 'autoTraderConfig', value: JSON.stringify(config), description: 'Auto-trader configuration' },
          update: { value: JSON.stringify(config) },
        });
        
        return NextResponse.json({ 
          success: true, 
          message: 'Auto-trader iniciado. El ciclo se ejecutará automáticamente.',
          config,
        });
      }
      
      case 'stop': {
        await db.appSettings.upsert({
          where: { key: 'autoTraderRunning' },
          create: { key: 'autoTraderRunning', value: 'false', description: 'Auto-trader is stopped' },
          update: { value: 'false' },
        });
        
        return NextResponse.json({ 
          success: true, 
          message: 'Auto-trader detenido.',
        });
      }
      
      case 'run-cycle': {
        const configSetting = await db.appSettings.findUnique({ where: { key: 'autoTraderConfig' } });
        const config = configSetting ? JSON.parse(configSetting.value) : DEFAULT_CONFIG;
        
        const result = await runAutoTraderCycle(config);
        
        return NextResponse.json({
          success: true,
          ...result,
        });
      }
      
      case 'update-config': {
        const newConfig = body.config || DEFAULT_CONFIG;
        await db.appSettings.upsert({
          where: { key: 'autoTraderConfig' },
          create: { key: 'autoTraderConfig', value: JSON.stringify(newConfig), description: 'Auto-trader configuration' },
          update: { value: JSON.stringify(newConfig) },
        });
        
        return NextResponse.json({ 
          success: true, 
          message: 'Configuración actualizada.',
          config: newConfig,
        });
      }
      
      default:
        return NextResponse.json({ error: 'Invalid action. Use: start, stop, run-cycle, update-config' }, { status: 400 });
    }
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
