export function calculateTokenSavings(tokensWithoutHippo = 0, tokensInjected = 0) {
  const without = Math.max(0, Number(tokensWithoutHippo) || 0);
  const withHippo = Math.max(0, Number(tokensInjected) || 0);
  const saved = Math.max(0, without - withHippo);
  return {
    tokens_without_hippo: without,
    tokens_injected: withHippo,
    tokens_saved: saved,
    reduction_percent: without > 0 ? Number(((saved / without) * 100).toFixed(1)) : 0,
  };
}
