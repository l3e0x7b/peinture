import React from "react";
import { ShieldCheck, ShieldAlert } from "lucide-react";
import { useConfigStore } from "../store/configStore";
import { useSettingsStore } from "../store/settingsStore";
import { ProviderId } from "../types";

interface Stats {
  total: number;
  active: number;
  exhausted: number;
}

const calculateStats = (tokens: string[], providerId: ProviderId): Stats => {
  const tokenStatus = useConfigStore.getState().tokenStatus[providerId];
  const exhaustedMap = tokenStatus?.exhausted || {};
  
  const total = tokens.length;
  const exhaustedCount = tokens.filter((t) => exhaustedMap[t]).length;
  
  return {
    total,
    active: total - exhaustedCount,
    exhausted: exhaustedCount,
  };
};

export const ProviderStatsMiniWidget: React.FC = () => {
  const { provider } = useSettingsStore();
  const { tokens } = useConfigStore();

  const currentProvider = provider as ProviderId;
  const providerTokens = tokens[currentProvider] || [];
  const stats = calculateStats(providerTokens, currentProvider);
  
  // 如果没有配置 token，不显示
  if (stats.total === 0) {
    return null;
  }

  return (
    <div className="flex items-center gap-3 text-xs">
      <div className="flex items-center gap-1.5">
        <span className="text-white/50">Total:</span>
        <span className="font-mono font-bold text-white">{stats.total}</span>
      </div>
      
      <div className="flex items-center gap-1.5">
        <ShieldCheck className="w-3.5 h-3.5 text-green-400" />
        <span className="font-mono font-bold text-green-400">{stats.active}</span>
      </div>
      
      <div className="flex items-center gap-1.5">
        <ShieldAlert className="w-3.5 h-3.5 text-red-400" />
        <span className="font-mono font-bold text-red-400">{stats.exhausted}</span>
      </div>
    </div>
  );
};