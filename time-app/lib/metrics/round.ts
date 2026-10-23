// How the Metrics page rounds (bj-finance #671): money, hours and rates to
// two places, shares and conversion rates to three.

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const round3 = (n: number) => Math.round(n * 1000) / 1000;
