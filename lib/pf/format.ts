// Dollars to the cent with a true minus sign ("−$1,234.50"), as the /money
// transaction table and the change-category dialog both show an amount.
export const fmt2 = (n: number) =>
  (n < 0 ? "−" : "") +
  "$" +
  Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
