import { useState, useCallback, useMemo } from "react";
import { ProviderId } from "../types";
import { useConfigStore } from "../store/configStore";

/**
 * Manages token-related form state for the settings dialog.
 * Handles HuggingFace, Gitee, ModelScope, A4F, OpenAI, Google, and Agnes tokens along with their stats.
 */
export const useTokensForm = () => {
  const { tokens, tokenStatus } = useConfigStore();

  // Token state
  const [token, setToken] = useState("");
  const [giteeToken, setGiteeToken] = useState("");
  const [msToken, setMsToken] = useState("");
  const [a4fToken, setA4FToken] = useState("");
  const [openaiToken, setOpenaiToken] = useState("");
  const [googleToken, setGoogleToken] = useState("");
  const [agnesToken, setAgnesToken] = useState("");

  const calculateStats = useCallback(
    (tokensList: string[], providerId: ProviderId) => {
      const total = tokensList.length;
      const exhaustedMap = tokenStatus[providerId]?.exhausted || {};
      const exhaustedCount = tokensList.filter((t) => exhaustedMap[t]).length;
      return {
        total,
        exhausted: exhaustedCount,
        active: total - exhaustedCount,
      };
    },
    [tokenStatus],
  );

  const initializeTokens = useCallback(() => {
    const hfTokens = tokens.huggingface || [];
    setToken(hfTokens.join(","));

    const gTokens = tokens.gitee || [];
    setGiteeToken(gTokens.join(","));

    const mTokens = tokens.modelscope || [];
    setMsToken(mTokens.join(","));

    const aTokens = tokens.a4f || [];
    setA4FToken(aTokens.join(","));

    const oTokens = tokens.openai || [];
    setOpenaiToken(oTokens.join(","));

    const googleTokens = tokens.google || [];
    setGoogleToken(googleTokens.join(","));

    const agnesTokens = tokens.agnes || [];
    setAgnesToken(agnesTokens.join(","));
  }, [tokens]);

  const updateToken = (type: ProviderId, value: string) => {
    if (type === "huggingface") {
      setToken(value);
    } else if (type === "gitee") {
      setGiteeToken(value);
    } else if (type === "modelscope") {
      setMsToken(value);
    } else if (type === "a4f") {
      setA4FToken(value);
    } else if (type === "openai") {
      setOpenaiToken(value);
    } else if (type === "google") {
      setGoogleToken(value);
    } else if (type === "agnes") {
      setAgnesToken(value);
    }
  };

  const stats = useMemo(
    () => calculateStats(tokens.huggingface || [], "huggingface"),
    [calculateStats, tokens.huggingface],
  );
  const giteeStats = useMemo(
    () => calculateStats(tokens.gitee || [], "gitee"),
    [calculateStats, tokens.gitee],
  );
  const msStats = useMemo(
    () => calculateStats(tokens.modelscope || [], "modelscope"),
    [calculateStats, tokens.modelscope],
  );
  const a4fStats = useMemo(
    () => calculateStats(tokens.a4f || [], "a4f"),
    [calculateStats, tokens.a4f],
  );
  const openaiStats = useMemo(
    () => calculateStats(tokens.openai || [], "openai"),
    [calculateStats, tokens.openai],
  );
  const googleStats = useMemo(
    () => calculateStats(tokens.google || [], "google"),
    [calculateStats, tokens.google],
  );
  const agnesStats = useMemo(
    () => calculateStats(tokens.agnes || [], "agnes"),
    [calculateStats, tokens.agnes],
  );

  return {
    token,
    stats,
    giteeToken,
    giteeStats,
    msToken,
    msStats,
    a4fToken,
    a4fStats,
    openaiToken,
    openaiStats,
    googleToken,
    googleStats,
    agnesToken,
    agnesStats,
    updateToken,
    initializeTokens,
  };
};